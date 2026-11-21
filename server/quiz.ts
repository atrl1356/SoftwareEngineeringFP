import type { Snapshot } from '../shared/types'
import { createHmac, randomBytes } from 'node:crypto'
import { freshCode } from './retention'
import { validLeader } from '../shared/types'
import { Store, check, id, type Row } from './db'
import { bookId, parseBook, type Sheets } from './sheets'

export class Quiz {
  private readonly openSecret = randomBytes(32)
  constructor(
    readonly db: Store,
    readonly sheets: Sheets,
  ) {}
  create(owner: string, title: string) {
    check(title.trim(), '請輸入活動名稱')
    const aid = id()
    const join = freshCode(this.db, aid)
    this.db.run(
      'INSERT INTO activities(id,owner,title,code,named_groups) VALUES(?,?,?,?,1)',
      aid,
      owner,
      title.trim(),
      join,
    )
    return aid
  }
  activity(aid: string) {
    const a = this.db.one('SELECT * FROM activities WHERE id=?', aid)
    check(a, '找不到活動', 404)
    check(a.removed_at === null, '活動已移除或無法使用', 410)
    return a
  }
  owned(owner: string, aid: string) {
    const a = this.db.one(
      'SELECT * FROM activities WHERE id=? AND owner=?',
      aid,
      owner,
    )
    check(a, '無權操作此活動', 403)
    check(a.removed_at === null, '活動已移除或無法使用', 410)
    return a
  }
  join(
    session: Row,
    leader: string | undefined,
    joincode: string | undefined,
    groupName?: string,
  ) {
    return this.db.tx(() => {
      const a = this.activity(session.aid)
      let g: Row | undefined
      if (leader !== undefined) {
        check(leader.trim(), '請輸入學號')
        g = this.db.one(
          'SELECT * FROM groups_ WHERE aid=? AND leader=?',
          a.id,
          leader.trim(),
        )
        if (g) {
          check(
            session.isleader && session.gid === g.id,
            '該組長已建組，請用組內碼加入',
            409,
          )
        } else {
          check(a.phase !== '已結束', '活動已結束', 409)
          check(!session.gid, '請以原組身分參與', 409)
          check(validLeader(leader), '組長學號須為以 1 開頭的九位半形數字')
          check(groupName !== undefined, '請輸入組別名稱')
          const name = groupName.trim()
          check(Array.from(name).length >= 1 && Array.from(name).length <= 20, '組別名稱須為 1 至 20 個字元')
          check(!/\p{Cc}/u.test(name), '組別名稱不可含換行或控制字元')
          check(
            !this.db.one('SELECT 1 FROM groups_ WHERE aid=? AND name=?', a.id, name),
            '此活動已有相同組別名稱',
            409,
          )
          const n = this.db.one(
            'SELECT COUNT(*) n FROM groups_ WHERE aid=?',
            a.id,
          )!.n
          const c = freshCode(this.db, a.id)
          const gid = id()
          this.db.run(
            'INSERT INTO groups_(id,aid,leader,label,name,joincode) VALUES(?,?,?,?,?,?)',
            gid,
            a.id,
            leader.trim(),
            'G' + String(n + 1).padStart(2, '0'),
            name,
            c,
          )
          g = this.db.one('SELECT * FROM groups_ WHERE id=?', gid)!
        }
      } else {
        g = this.db.one(
          'SELECT * FROM groups_ WHERE aid=? AND joincode=?',
          a.id,
          joincode ?? '',
        )
        check(g, '組內加入碼無效', 403)
      }
      this.db.run(
        'UPDATE sessions SET gid=?,isleader=? WHERE token=?',
        g.id,
        leader !== undefined ? 1 : 0,
        session.token,
      )
      return {
        label: a.named_groups ? g.name : g.label,
        ...(leader !== undefined ? { joinCode: g.joincode } : {}),
      }
    })
  }
  async import(owner: string, aid: string, url: string, tab: number) {
    const a = this.owned(owner, aid)
    check(a.phase === '準備中', '開場後題目已鎖定', 409)
    const attempt = this.db.one(
      'UPDATE activities SET ready=0,import_revision=import_revision+1 WHERE id=? RETURNING import_revision',
      aid,
    )!.import_revision
    const book = await this.sheets.read(owner, bookId(url))
    const imported = parseBook(book, tab)
    this.db.tx(() => {
      const current = this.activity(aid)
      check(current.phase === '準備中', '開場後題目已鎖定', 409)
      check(
        current.version === a.version && current.import_revision === attempt,
        '已有較新的匯入選擇，請核對目前版本',
        409,
      )
      this.db.run('DELETE FROM questions WHERE aid=?', aid)
      imported.questions.forEach((q, i) =>
        this.db.run(
          'INSERT INTO questions(aid,q,label,stem,pos,targets) VALUES(?,?,?,?,?,?)',
          aid,
          q.q,
          q.label,
          q.stem,
          i,
          JSON.stringify(q.targets),
        ),
      )
      this.db.run(
        'UPDATE activities SET source=?,ready=1 WHERE id=?',
        JSON.stringify({
          book: book.id,
          title: book.title,
          tab,
          tabTitle: imported.tab.title,
        }),
        aid,
      )
    })
  }
  async reselect(
    owner: string,
    aid: string,
    book: string,
    tab: number,
    count: number,
  ) {
    const a = this.owned(owner, aid)
    check(a.phase === '準備中' && a.source, '沒有可恢復的版本')
    const attempt = this.db.one(
      'UPDATE activities SET ready=0,import_revision=import_revision+1 WHERE id=? RETURNING import_revision',
      aid,
    )!.import_revision
    const src = JSON.parse(a.source)
    const original = this.db.all(
      'SELECT q,label,stem FROM questions WHERE aid=? ORDER BY pos',
      aid,
    )
    check(
      src.book === book && src.tab === tab && original.length === count,
      '請確認原版本',
    )
    const now = parseBook(await this.sheets.read(owner, book), tab).questions
    check(
      now.length === count &&
        now.every(
          (q, i) =>
            q.q === original[i].q &&
            q.label === original[i].label &&
            q.stem === original[i].stem,
        ),
      '原表已變更，請重新匯入',
      409,
    )
    const result = this.db.run(
      "UPDATE activities SET ready=1 WHERE id=? AND source=? AND import_revision=? AND phase='準備中' AND removed_at IS NULL AND version=?",
      aid,
      a.source,
      attempt,
      a.version,
    )
    check(result.changes === 1, '活動或匯入版本已改變', 409)
  }
  control(
    owner: string,
    aid: string,
    action: 'open' | 'close',
    confirmation?: unknown,
  ) {
    return this.db.tx(() => {
      const a = this.owned(owner, aid)
      if (action === 'open') {
        check(a.phase !== '已結束', '活動已結束', 409)
        check(a.ready, '請確認匯入版本', 409)
        if (a.phase === '開放中') return { phase: a.phase }
        const challenge = createHmac('sha256', this.openSecret)
          .update(JSON.stringify([owner, aid, a.version, a.import_revision]))
          .digest('base64url')
        if (confirmation !== undefined)
          check(confirmation === challenge, '開場確認已失效，請重新開場', 409)
        else if (
          !this.db.one('SELECT 1 FROM groups_ WHERE aid=? LIMIT 1', aid)
        ) {
          return { phase: a.phase, confirmation: challenge }
        }
        this.db.run("UPDATE activities SET phase='開放中' WHERE id=?", aid)
      } else {
        check(a.phase !== '準備中', '尚未開始', 409)
        if (a.phase === '開放中') {
          this.db.run("UPDATE activities SET phase='已結束' WHERE id=?", aid)
          this.db.run(
            'UPDATE questions SET winner=(SELECT gid FROM submissions s WHERE s.aid=questions.aid AND s.q=questions.q AND rank=1) WHERE aid=?',
            aid,
          )
          this.db.run(
            "UPDATE questions SET progress='略過' WHERE aid=? AND winner IS NULL",
            aid,
          )
        }
      }
      return { phase: this.activity(aid).phase }
    })
  }
  submit(s: Row, aid: string, q: string, text: string, seq: number) {
    check(s.aid === aid && s.gid, '無權提交', 403)
    const answer = text.replace(/\r\n?/g, '\n')
    return this.db.tx(() => {
      const a = this.activity(aid)
      const prior = this.db.one(
        'SELECT answer FROM submissions WHERE aid=? AND q=? AND gid=?',
        aid,
        q,
        s.gid,
      )
      if (prior?.answer === answer) return { answer, status: '先前已收件' }
      check(
        a.phase === '開放中',
        a.phase === '準備中' ? '尚未開始' : '活動已結束',
        409,
      )
      check(
        this.db.one('SELECT q FROM questions WHERE aid=? AND q=?', aid, q),
        '題號無效',
      )
      check(answer.trim(), '答案不能是空白')
      check(!prior, '本組已提交', 409)
      this.db.run(
        'INSERT INTO submissions VALUES(?,?,?,?,?,(SELECT COUNT(*)+1 FROM submissions WHERE aid=? AND q=?))',
        aid,
        q,
        s.gid,
        answer,
        seq,
        aid,
        q,
      )
      return { answer, status: '已收件' }
    })
  }
  view(aid: string, s: Row): Snapshot {
    const teacher = !!s.teacher
    if (!teacher) check(s.aid === aid, '無權查看', 403)
    const a = teacher ? this.owned(s.teacher, aid) : this.activity(aid)
    if (!teacher) {
      const me = this.db.one(
        'SELECT label,name,joincode FROM groups_ WHERE aid=? AND id=?',
        aid,
        s.gid,
      )
      const closed = a.phase === '已結束'
      const questions =
        !me || a.phase === '準備中'
          ? []
          : this.db
              .all(
                `
        SELECT q.q,q.label,own.answer AS ownAnswer,
               CASE WHEN a.named_groups THEN g.name ELSE g.label END AS winner,
               CASE WHEN q.published=1 THEN best.answer END AS winningAnswer
        FROM questions q
        JOIN activities a ON a.id=q.aid
        LEFT JOIN submissions own ON own.aid=q.aid AND own.q=q.q AND own.gid=?
        LEFT JOIN groups_ g ON g.aid=q.aid AND g.id=q.winner
        LEFT JOIN submissions best ON best.aid=q.aid AND best.q=q.q AND best.gid=q.winner AND q.published=1
        WHERE q.aid=? ORDER BY q.pos`,
                s.gid,
                aid,
              )
              .map((r) => ({
                q: r.q,
                label: r.label,
                ownAnswer: r.ownAnswer,
                ...(closed ? { winner: r.winner } : {}),
                ...(closed && r.winningAnswer != null
                  ? { winningAnswer: r.winningAnswer }
                  : {}),
              }))
      return {
        id: a.id,
        title: a.title,
        phase: a.phase,
        group: me ? (a.named_groups ? me.name : me.label) : null,
        questions,
        ...(s.isleader && me && !closed ? { joinCode: me.joincode } : {}),
      }
    }
    const groups = this.db.all(
      'SELECT label,name,leader,joincode FROM groups_ WHERE aid=? ORDER BY rowid',
      aid,
    )
    const items = this.db.all(
      'SELECT * FROM questions WHERE aid=? ORDER BY pos',
      aid,
    )
    const answers = this.db.all(
      `SELECT s.q,s.gid,g.label,g.name,s.answer,s.rank FROM submissions s
      JOIN groups_ g ON g.aid=s.aid AND g.id=s.gid WHERE s.aid=? ORDER BY s.q,s.rank`,
      aid,
    )
    const byQuestion = Map.groupBy(answers, (r) => r.q)
    const questions = items.map((q) => {
      const subs = byQuestion.get(q.q) ?? [],
        best = subs.find((x) => x.gid === q.winner)
      return {
        q: q.q,
        label: q.label,
        ...(a.phase === '已結束'
          ? { winner: best ? (a.named_groups ? best.name : best.label) : null }
          : {}),
        ...(best ? { winningAnswer: best.answer } : {}),
        published: !!q.published,
        progress: q.progress,
        submissions: subs.map((r) => ({
          label: a.named_groups ? r.name : r.label,
          ...(a.named_groups ? { code: r.label } : {}),
          answer: r.answer,
          rank: r.rank,
        })),
      }
    })
    return {
      id: a.id,
      title: a.title,
      phase: a.phase,
      questions,
      code: a.code,
      version: a.version,
      ready: !!a.ready,
      groups: groups.map((g) => ({
        label: a.named_groups ? g.name : g.label,
        ...(a.named_groups ? { code: g.label } : {}),
        leader: g.leader,
        ...(a.version > 0 && a.phase === '準備中'
          ? { joinCode: g.joincode }
          : {}),
      })),
      source: a.source ? JSON.parse(a.source) : null,
    }
  }
}
