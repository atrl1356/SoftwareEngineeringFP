import { check, id, Problem, type Store } from './db'
import { parseBook, type Sheets, type Target } from './sheets'

interface Slot extends Target {
  expected: string
  version: number
  writer: string | null
}
interface Preview {
  version: number
  key: string
  slots: Slot[]
  job: string
  bookTitle: string
  tabTitle: string
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const matches = (s: Slot) => same(s.value, { stringValue: s.expected })
function bounds(a1: string) {
  const coords = (s: string) => {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(s)!
    return [
      Number(row),
      Array.from(col).reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0),
    ]
  }
  const [from, to = from] = a1.split(':')
  return [...coords(from), ...coords(to)]
}
function overlap(a: string, b: string) {
  const [r, c, R, C] = bounds(a),
    [y, x, Y, X] = bounds(b)
  return r <= Y && y <= R && c <= X && x <= C
}
export class Writeback {
  private tails = new Map<string, Promise<unknown>>()
  constructor(
    private db: Store,
    private sheets: Sheets,
  ) {}
  private context(owner: string, aid: string, q: string) {
    const a = this.db.one(
      'SELECT * FROM activities WHERE id=? AND owner=?',
      aid,
      owner,
    )
    check(a, '無權操作', 403)
    check(a.removed_at === null, '活動已移除或無法使用', 410)
    check(a.phase === '已結束', '尚未結束', 409)
    const item = this.db.one(
      'SELECT * FROM questions WHERE aid=? AND q=?',
      aid,
      q,
    )
    check(item, '題號無效')
    check(item.winner, '無有效作答／略過', 409)
    return { src: JSON.parse(a.source), item, version: Number(a.version) }
  }
  private async inspect(
    owner: string,
    aid: string,
    q: string,
  ): Promise<Preview> {
    const { src, item, version } = this.context(owner, aid, q)
    const b = await this.sheets.read(owner, src.book)
    this.checkVersion(aid, version)
    const live = parseBook(b, src.tab, q).questions.find((x) => x.q === q)
    check(live && live.stem === item.stem, '原題已變更，暫停回寫', 409)
    const best = this.db.one(
      'SELECT s.answer,g.label FROM submissions s JOIN groups_ g ON g.id=s.gid WHERE s.aid=? AND s.q=? AND s.gid=?',
      aid,
      q,
      item.winner,
    )!
    const marks = this.db.all(
      'SELECT * FROM marks WHERE book=? AND tab=? ORDER BY version DESC',
      src.book,
      src.tab,
    )
    const slots = live.targets.map((t, i) => {
      const m = marks.find((m) => overlap(m.cell, t.range))
      return {
        ...t,
        expected: i === 0 ? best.answer : best.label,
        version: m?.version ?? 0,
        writer: m?.job ?? null,
      }
    })
    return {
      version,
      job: aid + '/' + q,
      key: id(),
      slots,
      bookTitle: b.title,
      tabTitle: b.tabs.find((t) => t.id === src.tab)!.title,
    }
  }
  private checkVersion(aid: string, version: number) {
    check(
      this.db.one(
        'SELECT 1 FROM activities WHERE id=? AND version=? AND removed_at IS NULL',
        aid,
        version,
      ),
      '活動已變更或移除',
      409,
    )
  }
  private async locked<T>(
    owner: string,
    aid: string,
    q: string,
    kind: 'preview' | 'confirm' | 'retry',
    fn: (job: string) => Promise<T>,
  ) {
    const job = id()
    const { src, version } = this.db.tx(() => {
      const context = this.context(owner, aid, q)
      if (kind !== 'preview') {
        this.db.run(
          'INSERT INTO write_jobs VALUES(?,?,?,?,?,?)',
          job,
          aid,
          q,
          context.version,
          kind,
          '排隊中',
        )
      }
      return context
    })
    const scope = src.book + '/' + src.tab
    const run = (this.tails.get(scope) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        this.checkVersion(aid, version)
        if (kind !== 'preview')
          this.db.run("UPDATE write_jobs SET state='執行中' WHERE id=?", job)
        return fn(job)
      })
    this.tails.set(scope, run)
    try {
      return await run
    } finally {
      if (kind !== 'preview')
        this.db.run('DELETE FROM write_jobs WHERE id=?', job)
      if (this.tails.get(scope) === run) this.tails.delete(scope)
    }
  }
  private savePreview(aid: string, q: string, p: Preview, conflict = false) {
    this.checkVersion(aid, p.version)
    this.db.run(
      "UPDATE questions SET preview=?,progress=CASE WHEN ? THEN '需確認衝突' ELSE progress END WHERE aid=? AND q=?",
      JSON.stringify(p),
      Number(conflict),
      aid,
      q,
    )
    return p
  }
  preview(owner: string, aid: string, q: string) {
    return this.locked(owner, aid, q, 'preview', async () =>
      this.savePreview(aid, q, await this.inspect(owner, aid, q)),
    )
  }
  confirm(
    owner: string,
    aid: string,
    q: string,
    key: string,
    approved: string[],
  ) {
    return this.locked(owner, aid, q, 'confirm', async (job) => {
      const { item, version } = this.context(owner, aid, q)
      const prior: Preview | null = JSON.parse(item.preview ?? 'null')
      if (
        item.progress === '已確認寫入' &&
        (!prior || prior.key !== key || (prior.version ?? 0) !== version)
      )
        return { progress: item.progress }
      // 同一個確認因連按或回應遺失再送，只回覆先前的逐題進度。
      if (
        item.published &&
        item.consent &&
        JSON.parse(item.consent).key === key
      )
        return { progress: item.progress }
      let current: Preview
      try {
        current = await this.inspect(owner, aid, q)
      } catch (e) {
        this.db.run(
          "UPDATE questions SET preview=NULL,progress='需確認衝突' WHERE aid=? AND q=?",
          aid,
          q,
        )
        throw e
      }
      if (prior?.key !== key || !same(prior.slots, current.slots)) {
        this.savePreview(aid, q, current, true)
        throw new Problem('預覽已過期，請核對最新兩格', 409, current)
      }
      for (const s of current.slots)
        check(
          !s.value || matches(s) || approved.includes(s.address),
          '請逐格同意覆蓋 ' + s.address,
          409,
        )
      this.db.run(
        "UPDATE questions SET published=1,published_at=COALESCE(published_at,?),progress='待寫入',consent=?,preview=NULL WHERE aid=? AND q=?",
        Date.now(),
        JSON.stringify({ ...current, key }),
        aid,
        q,
      )
      return this.perform(owner, aid, q, job)
    })
  }
  retry(owner: string, aid: string, q: string) {
    return this.locked(owner, aid, q, 'retry', async (job) => {
      const { item } = this.context(owner, aid, q)
      if (item.progress === '已確認寫入') return { progress: item.progress }
      check(item.progress !== '需確認衝突', '請重新確認兩格', 409)
      return this.perform(owner, aid, q, job)
    })
  }
  private async perform(owner: string, aid: string, q: string, job: string) {
    const { src, item } = this.context(owner, aid, q)
    check(item.published && item.consent, '請先確認該題', 409)
    const consent: Preview = JSON.parse(item.consent)
    try {
      const current = await this.inspect(owner, aid, q)
      const changed = current.slots.some((s, i) => {
        const old = consent.slots[i]
        return (
          s.range !== old.range ||
          (s.version !== old.version && s.writer !== consent.job) ||
          (!matches(s) && !same(s.value, old.value))
        )
      })
      if (changed) {
        this.savePreview(aid, q, current, true)
        throw new Problem(
          '兩格位置、原值或跨場版本已變，請重新確認',
          409,
          current,
        )
      }
      const edits = current.slots.filter((s) => !matches(s))
      if (edits.length) {
        this.db.tx(() => {
          this.checkVersion(aid, current.version)
          // 在送出可能生效的外部寫入之前持久標示未知結果，重啟時先讀回。
          this.db.run(
            "UPDATE questions SET progress='待核實' WHERE aid=? AND q=?",
            aid,
            q,
          )
          for (const s of edits)
            this.db.run(
              `INSERT OR REPLACE INTO marks(book,tab,cell,job,version)
            VALUES(?,?,?,?,(SELECT COALESCE(MAX(version),0)+1 FROM marks))`,
              src.book,
              src.tab,
              s.range,
              consent.job,
            )
        })
        await this.sheets.write(
          owner,
          src.book,
          src.tab,
          edits.map((s) => ({ ...s, text: s.expected })),
        )
        const after = await this.inspect(owner, aid, q)
        check(
          after.slots.every(
            (s, i) => matches(s) && s.range === current.slots[i].range,
          ),
          '寫後雙格尚未核實',
          502,
        )
      }
      this.db.tx(() => {
        this.checkVersion(aid, current.version)
        this.db.run(
          "UPDATE questions SET progress='已確認寫入' WHERE aid=? AND q=?",
          aid,
          q,
        )
        this.db.run('DELETE FROM write_jobs WHERE id=?', job)
      })
      return { progress: '已確認寫入' }
    } catch (e) {
      const conflict = e instanceof Problem && e.statusCode === 409
      this.db.tx(() => {
        this.db.run(
          'UPDATE questions SET progress=? WHERE aid=? AND q=?',
          conflict ? '需確認衝突' : e instanceof Problem ? '失敗' : '待核實',
          aid,
          q,
        )
        this.db.run('DELETE FROM write_jobs WHERE id=?', job)
      })
      throw e
    }
  }
  async recover() {
    // 單一服務啟動時，舊程序的佇列已不存在。以持久化的有效同意與逐題進度重建。
    const jobs = this.db.tx(() => {
      this.db.run('DELETE FROM write_jobs')
      return this.db
        .all(`SELECT q.aid,q.q,a.owner FROM questions q JOIN activities a ON a.id=q.aid
        WHERE a.removed_at IS NULL AND published=1 AND consent IS NOT NULL
          AND COALESCE(json_extract(consent,'$.version'),0)=a.version AND progress IN ('待寫入','待核實')`)
    })
    for (const j of jobs) {
      try {
        await this.retry(j.owner, j.aid, j.q)
      } catch {
        /* 保留可見狀態供教師重試。 */
      }
    }
  }
}
