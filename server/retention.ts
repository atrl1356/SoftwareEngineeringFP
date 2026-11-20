import { randomInt } from 'node:crypto'
import { check, Problem, type Row, type Store } from './db'
import type {
  ActivityItem,
  ActivitySelection,
  OperationResult,
} from '../shared/types'

export const retentionMs = 240 * 60 * 60 * 1000
export const code = () => String(randomInt(100000, 1000000))

export function freshCode(db: Store, aid: string, next = code) {
  for (let i = 0; i < 100; i++) {
    const candidate = next()
    if (
      !db.one(
        `SELECT 1 FROM activities WHERE code=?
      UNION ALL SELECT 1 FROM groups_ WHERE aid=? AND joincode=?
      UNION ALL SELECT 1 FROM retired_codes WHERE code=? LIMIT 1`,
        candidate,
        aid,
        candidate,
        candidate,
      )
    )
      return candidate
  }
  throw new Problem('暫時無法配置新碼，請重試', 503)
}

export class Retention {
  constructor(
    private db: Store,
    private now = Date.now,
    private nextCode = code,
  ) {}

  private reason(a: Row): string {
    if (a.phase === '開放中') return '請先截止搶答'
    if (a.phase === '準備中') return ''
    const pending = this.db.all(
      `SELECT label,progress FROM questions WHERE aid=? AND
      ((winner IS NULL AND progress!='略過') OR (winner IS NOT NULL AND progress!='已確認寫入')) ORDER BY pos`,
      a.id,
    )
    const jobs = this.db.all(
      `SELECT DISTINCT q.label,w.state FROM write_jobs w
      JOIN questions q ON q.aid=w.aid AND q.q=w.q WHERE w.aid=?`,
      a.id,
    )
    return [
      ...pending.map((q) => '第 ' + q.label + ' 題 ' + q.progress),
      ...jobs.map((j) => '第 ' + j.label + ' 題回寫' + j.state),
    ].join('、')
  }

  list(owner: string, removed: boolean): ActivityItem[] {
    const rows = removed
      ? this.db.all(
          'SELECT * FROM activities WHERE owner=? AND removed_at>? ORDER BY removed_at DESC',
          owner,
          this.now() - retentionMs,
        )
      : this.db.all(
          'SELECT * FROM activities WHERE owner=? AND removed_at IS NULL ORDER BY rowid DESC',
          owner,
        )
    return rows.map((a) => ({
      id: a.id,
      title: a.title,
      code: a.code,
      phase: a.phase,
      version: a.version,
      reason: removed ? '' : this.reason(a),
      expiresAt: removed ? a.removed_at + retentionMs : null,
    }))
  }

  private rotate(a: Row) {
    const groups = this.db.all(
      'SELECT id,joincode FROM groups_ WHERE aid=?',
      a.id,
    )
    for (const old of [a.code, ...groups.map((g) => g.joincode)]) {
      this.db.run('INSERT OR IGNORE INTO retired_codes VALUES(?,?)', a.id, old)
    }
    this.db.run(
      'UPDATE activities SET code=? WHERE id=?',
      freshCode(this.db, a.id, this.nextCode),
      a.id,
    )
    for (const group of groups) {
      this.db.run(
        'UPDATE groups_ SET joincode=? WHERE id=?',
        freshCode(this.db, a.id, this.nextCode),
        group.id,
      )
    }
  }

  change(
    owner: string,
    kind: 'remove' | 'restore',
    operation: string,
    items: ActivitySelection[],
  ): OperationResult[] {
    check(
      typeof operation === 'string' &&
        operation.length > 0 &&
        operation.length <= 128,
      '缺少操作識別',
    )
    check(
      Array.isArray(items) &&
        items.every(
          (i) =>
            i && typeof i.id === 'string' && Number.isSafeInteger(i.version),
        ),
      '活動清單無效',
    )
    const unique = new Map(items.map((i) => [i.id, i]))
    return [...unique.values()].map((item) => {
      try {
        return this.db.tx(() => this.changeOne(owner, kind, operation, item))
      } catch (e) {
        return {
          id: item.id,
          message: e instanceof Problem ? e.message : '處理失敗，可重試',
        }
      }
    })
  }

  private changeOne(
    owner: string,
    kind: 'remove' | 'restore',
    operation: string,
    item: ActivitySelection,
  ): OperationResult {
    const { id, version } = item
    const a = this.db.one(
      'SELECT * FROM activities WHERE id=? AND owner=?',
      id,
      owner,
    )
    check(a, '無法操作此活動', 403)
    const now = this.now()
    const removed = a.removed_at !== null
    check(!removed || now < a.removed_at + retentionMs, '還原期限已到')
    const current = removed ? '已移除' : '在我的活動中'
    const previous = this.db.one(
      'SELECT * FROM lifecycle_ops WHERE aid=? AND operation=?',
      id,
      operation,
    )
    if (previous) {
      check(
        previous.kind === kind && previous.expected === version,
        '操作識別不符',
      )
      if (previous.result_version === a.version)
        return JSON.parse(previous.response) as OperationResult
      return { id, message: current }
    }
    let resultingVersion = a.version
    const result: OperationResult = { id, message: current }
    if (version !== a.version) result.message = '活動狀態已變更：' + current
    else if (kind === 'remove' && !removed) {
      const reason = this.reason(a)
      if (reason) result.message = reason
      else {
        this.db.run(
          'UPDATE activities SET removed_at=?,version=version+1 WHERE id=?',
          now,
          id,
        )
        this.db.run('DELETE FROM sessions WHERE aid=?', id)
        resultingVersion++
        result.message = '已移除'
      }
    } else if (kind === 'restore' && removed) {
      if (a.phase === '準備中') {
        this.rotate(a)
        result.code = this.db.one(
          'SELECT code FROM activities WHERE id=?',
          id,
        )!.code
        result.groups = this.db
          .all(
            'SELECT label,joincode FROM groups_ WHERE aid=? ORDER BY rowid',
            id,
          )
          .map((g) => ({ label: g.label, code: g.joincode }))
      }
      this.db.run(
        'UPDATE activities SET removed_at=NULL,version=version+1 WHERE id=?',
        id,
      )
      resultingVersion++
      result.message = '已還原'
    }
    this.db.run(
      'INSERT INTO lifecycle_ops VALUES(?,?,?,?,?,?)',
      id,
      operation,
      kind,
      version,
      resultingVersion,
      JSON.stringify(result),
    )
    return result
  }

  sweep(onError: (error: unknown) => void) {
    const due = this.db.all(
      'SELECT id,version FROM activities WHERE removed_at<=?',
      this.now() - retentionMs,
    )
    for (const { id, version } of due) {
      try {
        this.db.tx(() => {
          if (
            !this.db.one(
              'SELECT id FROM activities WHERE id=? AND version=? AND removed_at<=?',
              id,
              version,
              this.now() - retentionMs,
            )
          )
            return
          for (const table of [
            'sessions',
            'submissions',
            'write_jobs',
            'questions',
            'groups_',
            'lifecycle_ops',
            'retired_codes',
          ]) {
            this.db.run('DELETE FROM ' + table + ' WHERE aid=?', id)
          }
          this.db.run('DELETE FROM activities WHERE id=?', id)
        })
      } catch (error) {
        onError(error)
      }
    }
  }
}
