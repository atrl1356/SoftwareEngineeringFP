import { afterEach, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store, id } from '../server/db'
import { FixtureSheets } from '../server/sheets'
import { Writeback } from '../server/writeback'
import { Retention, retentionMs } from '../server/retention'
import { application } from '../server/app'
import { setup, url, sample } from './support'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-retention-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const target = (id: string, version = 0) => ({ id, version })
function fixture(file?: string) {
  const h = setup(file)
  cleanup.push(() => {
    if (h.db.sql.isOpen) h.db.close()
  })
  let now = 1_000
  const life = new Retention(h.db, () => now)
  function change(
    kind: 'remove' | 'restore',
    aid: string,
    version: number,
    op: string = id(),
  ) {
    return life.change(h.owner, kind, op, [target(aid, version)])[0]
  }
  return {
    ...h,
    life,
    change,
    advance: (ms: number) => {
      now += ms
    },
  }
}

it('第一輪資料庫副本升級兩次，學號、碼、提交、公布與待核實工作完整保留', () => {
  const dir = folder(),
    original = join(dir, 'first.sqlite'),
    copy = join(dir, 'copy.sqlite')
  const old = new DatabaseSync(original)
  old.exec(
    readFileSync(
      new URL('./fixtures/classroom-v1.sql', import.meta.url),
      'utf8',
    ),
  )
  old.exec(`INSERT INTO teachers VALUES('t','salt','hash','oauth');
    INSERT INTO activities(id,owner,title,code,phase) VALUES('a','t','舊場','654321','已結束');
    INSERT INTO groups_ VALUES('g','a','101','G01','987654');
    INSERT INTO questions(aid,q,label,stem,pos,targets,winner,published,progress)
      VALUES('a','1','1','舊題',0,'[]','g',1,'待核實');
    INSERT INTO inbox DEFAULT VALUES;
    INSERT INTO submissions VALUES('a','1','g','CPU',1,1);
    INSERT INTO marks VALUES('book',1,'C3:C3','a/1',4);`)
  old.close()
  copyFileSync(original, copy)
  for (let i = 0; i < 2; i++) {
    const db = new Store(copy)
    try {
      expect(db.all('PRAGMA foreign_key_check')).toEqual([])
      expect(
        db.one('SELECT code,version,removed_at,phase FROM activities'),
      ).toEqual({
        code: '654321',
        version: 0,
        removed_at: null,
        phase: '已結束',
      })
      expect(db.all('SELECT leader,label,joincode FROM groups_')).toEqual([
        { leader: '101', label: 'G01', joincode: '987654' },
      ])
      expect(db.one('SELECT progress,winner,published FROM questions')).toEqual(
        { progress: '待核實', winner: 'g', published: 1 },
      )
      expect(db.one('SELECT answer,seq,rank FROM submissions')).toEqual({
        answer: 'CPU',
        seq: 1,
        rank: 1,
      })
      expect(db.one('SELECT version FROM marks')?.version).toBe(4)
      expect(
        db.one("SELECT name FROM sqlite_master WHERE name='activities_expiry'"),
      ).toBeDefined()
    } finally {
      db.close()
    }
  }
})

it('混選、越權、全數不符與失敗後重送均逐場處理', async () => {
  const file = join(folder(), 'batch.sqlite'),
    h = fixture(file),
    prep = await h.activity(),
    opened = await h.activity(),
    failed = await h.settled(),
    done = await h.activity()
  h.member(opened, '123456789')
  h.quiz.control(h.owner, opened, 'open')
  const confirm = h.quiz.control(h.owner, done, 'open').confirmation
  h.quiz.control(h.owner, done, 'open', confirm)
  h.quiz.control(h.owner, done, 'close')
  h.db.teacher('other', h.password)
  const foreign = h.quiz.create('other', '私人')
  h.db.run(
    "UPDATE questions SET progress='失敗' WHERE aid=? AND q='1'",
    failed.aid,
  )
  const items = [prep, opened, failed.aid, done, foreign, 'missing', prep].map(
    (a) => target(a),
  )
  const op = id()
  h.db.sql.exec(
    "CREATE TRIGGER fail_one BEFORE UPDATE OF removed_at ON activities WHEN OLD.phase='準備中' BEGIN SELECT RAISE(ABORT,'injected'); END",
  )
  const first = h.life.change(h.owner, 'remove', op, items)
  expect(first.map((r) => r.message)).toEqual([
    '處理失敗，可重試',
    '請先截止搶答',
    '第 1 題 失敗',
    '已移除',
    '無法操作此活動',
    '無法操作此活動',
  ])
  expect(h.life.list(h.owner, true).map((a) => a.id)).toEqual([done])
  h.db.sql.exec('DROP TRIGGER fail_one')
  const retry = h.life.change(h.owner, 'remove', op, items)
  expect(retry[0].message).toBe('已移除')
  expect(h.life.list(h.owner, true)).toHaveLength(2)
  expect(
    h.life
      .change(h.owner, 'remove', id(), [target(opened), target(failed.aid)])
      .map((r) => r.message),
  ).toEqual(['請先截止搶答', '第 1 題 失敗'])
  expect(h.life.list('other', true)).toEqual([])
  expect(h.life.change('other', 'restore', id(), [target(prep, 1)])[0]).toEqual(
    { id: prep, message: '無法操作此活動' },
  )
  const expires = h.life.list(h.owner, true)[0].expiresAt
  h.advance(5)
  expect(h.life.change(h.owner, 'remove', op, items)).toEqual(retry)
  expect(h.life.list(h.owner, true)[0].expiresAt).toBe(expires)
  h.change('restore', prep, 1)
  expect(h.change('remove', prep, 0, op).message).toBe('在我的活動中')
  expect(h.quiz.activity(prep).version).toBe(2)
  // 模擬服務在第一筆交易提交後中斷，以同一操作識別重送原批次。
  const remaining = await h.activity(),
    batch = id()
  const itemsToReplay = [target(prep, 2), target(remaining)]
  const firstResult = h.life.change(
    h.owner,
    'remove',
    batch,
    itemsToReplay.slice(0, 1),
  )[0]
  const firstTime = h.db.one(
    'SELECT removed_at FROM activities WHERE id=?',
    prep,
  )
  h.db.close()
  const reopened = new Store(file)
  cleanup.push(() => reopened.close())
  const resumed = new Retention(reopened, () => 2000)
  expect(resumed.change(h.owner, 'remove', batch, itemsToReplay)).toEqual([
    firstResult,
    { id: remaining, message: '已移除' },
  ])
  expect(
    reopened.one('SELECT removed_at FROM activities WHERE id=?', prep),
  ).toEqual(firstTime)
})

it('換碼碰撞與中途錯誤整筆回滾，兩組以新碼加入原名冊', async () => {
  const h = fixture(),
    aid = await h.activity(),
    a = h.member(aid, '123456789'),
    b = h.member(aid, '123456788')
  const original = h.quiz.activity(aid).code
  h.change('remove', aid, 0)
  const collides = new Retention(
    h.db,
    () => 1000,
    () => original,
  )
  expect(
    collides.change(h.owner, 'restore', id(), [target(aid, 1)])[0].message,
  ).toContain('重試')
  h.db.sql.exec(
    "CREATE TRIGGER fail_second BEFORE UPDATE OF joincode ON groups_ WHEN OLD.label='G02' BEGIN SELECT RAISE(ABORT,'fail'); END",
  )
  expect(h.change('restore', aid, 1).message).toContain('失敗')
  expect(h.db.one('SELECT code,version FROM activities')).toEqual({
    code: original,
    version: 1,
  })
  expect(
    h.db
      .all('SELECT joincode FROM groups_ ORDER BY label')
      .map((r) => r.joincode),
  ).toEqual([a.group.joinCode, b.group.joinCode])
  h.db.sql.exec('DROP TRIGGER fail_second')
  const op = id(),
    result = h.change('restore', aid, 1, op)
  expect(h.change('restore', aid, 1, op)).toEqual(result)
  expect(
    new Set([
      original,
      a.group.joinCode,
      b.group.joinCode,
      result.code,
      ...result.groups!.map((g) => g.code),
    ]).size,
  ).toBe(6)
  expect(result.groups!.map((g) => g.label)).toEqual(['G01', 'G02'])
})

it('移除、還原與逾期清理在期限邊界與失敗中保持整筆交易', async () => {
  const h = fixture(),
    saved = await h.activity(),
    done = await h.settled()
  const p = await h.writer.preview(h.owner, done.aid, '1')
  await h.writer.confirm(h.owner, done.aid, '1', p.key, [])
  const marks = h.db.all('SELECT * FROM marks'),
    seq = h.db.all('SELECT * FROM inbox')
  h.db.run('UPDATE teachers SET google=?', '授權紀錄')
  h.db.run('INSERT INTO oauth VALUES(?,?,?)', 'state', h.owner, 10)
  h.change('remove', saved, 0)
  h.change('remove', done.aid, 0)
  h.advance(retentionMs - 1)
  expect(h.change('restore', saved, 1).message).toBe('已還原')
  h.advance(1)
  expect(h.change('restore', done.aid, 1).message).toContain('期限')
  expect(h.life.list(h.owner, true)).toHaveLength(0)
  h.db.sql.exec(
    "CREATE TRIGGER fail_purge BEFORE DELETE ON groups_ BEGIN SELECT RAISE(ABORT,'fail'); END",
  )
  const onError = vi.fn()
  h.life.sweep(onError)
  expect(onError).toHaveBeenCalledOnce()
  expect(
    h.db.one('SELECT answer FROM submissions WHERE aid=?', done.aid)?.answer,
  ).toBe('CPU')
  h.db.sql.exec('DROP TRIGGER fail_purge')
  h.life.sweep(onError)
  for (const table of [
    'groups_',
    'sessions',
    'questions',
    'submissions',
    'retired_codes',
    'write_jobs',
    'lifecycle_ops',
  ]) {
    expect(
      h.db.all('SELECT 1 FROM ' + table + ' WHERE aid=?', done.aid),
    ).toEqual([])
  }
  expect(h.db.all('SELECT id FROM activities')).toEqual([{ id: saved }])
  expect(h.db.one('SELECT google FROM teachers')?.google).toBe('授權紀錄')
  expect(h.db.all('SELECT * FROM oauth')).toHaveLength(1)
  expect(h.db.all('SELECT * FROM marks')).toEqual(marks)
  expect(h.db.all('SELECT * FROM inbox')).toEqual(seq)
  expect(h.db.all('PRAGMA foreign_key_check')).toEqual([])
})

it.each([true, false])(
  '還原請求與掃描並發，還原先排入=%s，仍以交易當下的期限判決',
  async (restoreFirst) => {
    const h = fixture(join(folder(), 'race.sqlite'))
    for (const offset of [retentionMs - 1, retentionMs]) {
      const aid = await h.activity()
      h.change('remove', aid, 0)
      h.advance(offset)
      const restore = () => h.change('restore', aid, 1).message
      const sweep = () =>
        h.life.sweep((error) => {
          throw error
        })
      const operations = restoreFirst ? [restore, sweep] : [sweep, restore]
      const results = await Promise.all(
        operations.map((op) => Promise.resolve().then(() => op())),
      )
      const saved = h.db.one(
        'SELECT version,removed_at FROM activities WHERE id=?',
        aid,
      )
      if (offset < retentionMs) {
        expect(results).toContain('已還原')
        expect(saved).toEqual({ version: 2, removed_at: null })
      } else {
        expect(results).not.toContain('已還原')
        expect(saved).toBeUndefined()
      }
    }
  },
)

it('服務停機跨期時啟動補清，運行期間也自動掃描', async () => {
  const file = join(folder(), 'classroom.sqlite'),
    h = setup(file)
  const first = await h.activity(),
    second = await h.activity()
  new Retention(h.db, () => 1000).change(h.owner, 'remove', id(), [
    target(first),
  ])
  new Retention(h.db, () => 1010).change(h.owner, 'remove', id(), [
    target(second),
  ])
  h.db.close()
  let now = retentionMs + 1000
  const db = new Store(file),
    app = application({
      db,
      sheets: h.sheets,
      now: () => now,
      sweepIntervalMs: 10,
    })
  cleanup.push(async () => {
    await app.close()
    db.close()
  })
  await app.ready()
  expect(db.all('SELECT id FROM activities')).toEqual([{ id: second }])
  now += 10
  await vi.waitFor(() =>
    expect(db.all('SELECT id FROM activities')).toEqual([]),
  )
})

it.each([
  ['import', false],
  ['import', true],
  ['reselect', false],
  ['reselect', true],
] as const)(
  '舊 %s 讀取完成時，還原=%s，題目與開場旗標維持移除時的狀態',
  async (kind, restore) => {
    const h = fixture(),
      aid = await h.activity()
    const pause = Promise.withResolvers<void>()
    const original = h.sheets.read.bind(h.sheets)
    vi.spyOn(h.sheets, 'read').mockImplementationOnce(async (...args) => {
      await pause.promise
      return original(...args)
    })
    const work =
      kind === 'import'
        ? h.quiz.import(h.owner, aid, url, 1)
        : h.quiz.reselect(h.owner, aid, 'classroom-fixture-v1', 1, 6)
    const before = h.db.all('SELECT * FROM questions WHERE aid=?', aid)
    const write = vi.spyOn(h.sheets, 'write')
    h.change('remove', aid, 0)
    if (restore) h.change('restore', aid, 1)
    pause.resolve()
    await expect(work).rejects.toThrow()
    expect(
      h.db.one('SELECT ready FROM activities WHERE id=?', aid)?.ready,
    ).toBe(0)
    expect(h.db.all('SELECT * FROM questions WHERE aid=?', aid)).toEqual(before)
    expect(write).not.toHaveBeenCalled()
  },
)

it('移除後停用所有學生與教師舊入口，已結束還原須重新以原兩碼取得身分', async () => {
  const h = fixture(),
    { aid, a } = await h.settled()
  const p = await h.writer.preview(h.owner, aid, '1')
  await h.writer.confirm(h.owner, aid, '1', p.key, [])
  const code = h.quiz.activity(aid).code
  const t = h.db.login(h.owner, h.password)
  const app = application({ db: h.db, sheets: h.sheets })
  cleanup.push(() => app.close())
  const call = (path: string, token?: string, payload?: object) =>
    app.inject({
      method: payload ? 'POST' : 'GET',
      url: '/api/' + path,
      headers: { authorization: 'Bearer ' + (token ?? '') },
      payload,
    })
  const base = 'activities/' + aid
  expect(
    (
      await call('teacher/remove', a.token, {
        operation: id(),
        items: [target(aid)],
      })
    ).statusCode,
  ).toBe(403)
  expect((await call('teacher', a.token)).statusCode).toBe(403)
  expect(
    (
      await call('teacher/restore', a.token, {
        operation: id(),
        items: [target(aid, 1)],
      })
    ).statusCode,
  ).toBe(403)
  const remove = { operation: id(), items: [target(aid)] }
  const restore = { operation: id(), items: [target(aid, 1)] }
  await call('teacher/remove', t, remove)
  expect((await call('enter', undefined, { code })).statusCode).toBe(404)
  for (const [path, payload] of [
    ['', undefined],
    ['/group', { joinCode: a.group.joinCode }],
    ['/questions/1/receipt', undefined],
    ['/questions/1/submit', { answer: 'CPU' }],
    ['/questions/1/submit', { answer: 'different' }],
  ] as const) {
    const res = await call(base + path, a.token, payload)
    expect(res.statusCode).toBe(401)
    expect(res.json()).not.toHaveProperty('answer')
  }
  expect((await call(base + '/open', t, {})).statusCode).toBe(410)
  expect((await call(base + '/questions/1/retry', t, {})).statusCode).toBe(410)
  const restored = (await call('teacher/restore', t, restore)).json()
  expect((await call('teacher/restore', t, restore)).json()).toEqual(restored)
  expect((await call('teacher/remove', t, remove)).json()).toEqual([
    { id: aid, message: '在我的活動中' },
  ])
  for (const path of [
    'open',
    'close',
    'questions/1/preview',
    'questions/1/retry',
  ]) {
    expect((await call(base + '/' + path, t, { version: 0 })).statusCode).toBe(
      409,
    )
  }
  expect(
    (await call(base + '/questions/1/retry', t, { version: 2 })).statusCode,
  ).toBe(200)
  expect((await call(base, a.token)).statusCode).toBe(401)
  const fresh = (await call('enter', undefined, { code })).json().token
  expect((await call(base + '/questions/1/receipt', fresh)).statusCode).toBe(
    403,
  )
  expect(
    (await call(base + '/group', fresh, { joinCode: 'bad' })).statusCode,
  ).toBe(403)
  await call(base + '/group', fresh, { joinCode: a.group.joinCode })
  expect((await call(base + '/questions/1/receipt', fresh)).json()).toEqual({
    answer: 'CPU',
  })
  expect(
    (await call(base + '/questions/1/submit', fresh, { answer: '新答' }))
      .statusCode,
  ).toBe(409)
  expect(
    (await call(base + '/group', fresh, { leader: '123456789' })).statusCode,
  ).toBe(409)
  expect((await call(base, fresh)).json().questions[0]).toEqual({
    q: '1',
    label: '1',
    ownAnswer: 'CPU',
    winner: 'G01',
    winningAnswer: 'CPU',
  })
  expect(h.db.all('SELECT rank FROM submissions')).toEqual([{ rank: 1 }])
})

it.each(['準備中', '開放中'])(
  '%s 的新建組 API 拒絕非九位半形學號但保留舊組',
  async (phase) => {
    const h = fixture(),
      aid = await h.activity(),
      old = h.member(aid, '123456788')
    h.db.run('UPDATE groups_ SET leader=? WHERE id=?', '101', old.session.gid)
    if (phase === '開放中') h.quiz.control(h.owner, aid, 'open')
    expect(h.quiz.join(old.session, '101', undefined).label).toBe('G01')
    const app = application({ db: h.db, sheets: h.sheets })
    cleanup.push(() => app.close())
    const token = h.db.session(null, aid)
    const post = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/api/activities/' + aid + '/group',
        headers: { authorization: 'Bearer ' + token },
        payload,
      })
    for (const leader of [
      '',
      '101',
      '023456789',
      '223456789',
      '１２３４５６７８９',
      '1234 6789',
      '12345678a',
      '12345678',
      '1234567890',
      123456789,
    ]) {
      expect((await post({ leader })).statusCode).toBeGreaterThanOrEqual(400)
    }
    expect((await post({ leader: ' 123456789 ' })).json().label).toBe('G02')
    expect((await post({ leader: '123456789' })).json().label).toBe('G02')
    expect(h.db.all('SELECT label,leader FROM groups_ ORDER BY label')).toEqual(
      [
        { label: 'G01', leader: '101' },
        { label: 'G02', leader: '123456789' },
      ],
    )
    expect((await post({ joinCode: old.group.joinCode })).json().label).toBe(
      'G01',
    )
  },
)

it('零組確認綁定所有權、場次、匯入版本與還原版本', async () => {
  const h = fixture(),
    a = await h.activity(),
    b = await h.activity()
  const prompt = h.quiz.control(h.owner, a, 'open').confirmation
  expect(prompt).toBeTruthy()
  expect(() => h.quiz.control('other', a, 'open', prompt)).toThrow('無權')
  expect(() => h.quiz.control(h.owner, b, 'open', prompt)).toThrow('失效')
  await h.quiz.import(h.owner, a, url, 1)
  expect(() => h.quiz.control(h.owner, a, 'open', prompt)).toThrow('失效')
  const next = h.quiz.control(h.owner, a, 'open').confirmation
  h.change('remove', a, 0)
  expect(() => h.quiz.control(h.owner, a, 'open', next)).toThrow('移除')
  h.change('restore', a, 1)
  expect(() => h.quiz.control(h.owner, a, 'open', next)).toThrow('失效')
  expect(h.quiz.activity(a).phase).toBe('準備中')
})

it('寫入排隊、外部寫入、寫後讀回均阻擋移除，失敗及未知結果須先處理', async () => {
  const h = fixture(),
    { aid } = await h.settled(),
    prepared = await h.writer.preview(h.owner, aid, '1')
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const reading = Promise.withResolvers<void>(),
    readRelease = Promise.withResolvers<void>()
  const originalWrite = h.sheets.write.bind(h.sheets),
    originalRead = h.sheets.read.bind(h.sheets)
  vi.spyOn(h.sheets, 'write').mockImplementationOnce(async (...args) => {
    entered.resolve()
    await release.promise
    await originalWrite(...args)
    vi.spyOn(h.sheets, 'read').mockImplementationOnce(async (...readArgs) => {
      reading.resolve()
      await readRelease.promise
      return originalRead(...readArgs)
    })
  })
  const writing = h.writer.confirm(h.owner, aid, '1', prepared.key, [])
  await entered.promise
  const waiting = h.writer.retry(h.owner, aid, '1')
  expect(
    h.db.all('SELECT state FROM write_jobs ORDER BY rowid').map((r) => r.state),
  ).toEqual(['執行中', '排隊中'])
  expect(h.change('remove', aid, 0).message).toContain('排隊中')
  release.resolve()
  await reading.promise
  expect(h.change('remove', aid, 0).message).toContain('執行中')
  readRelease.resolve()
  await Promise.all([waiting, writing])
  for (const progress of ['待核實', '失敗', '需確認衝突', '待寫入']) {
    h.db.run(
      "UPDATE questions SET progress=? WHERE aid=? AND q='1'",
      progress,
      aid,
    )
    expect(h.change('remove', aid, 0).message).toContain(progress)
  }
  h.db.run(
    "UPDATE questions SET progress='已確認寫入' WHERE aid=? AND q='1'",
    aid,
  )
  expect(h.change('remove', aid, 0).message).toBe('已移除')
  await expect(h.writer.retry(h.owner, aid, '1')).rejects.toThrow('移除')
})

it('同文字只重疊一格，A 還原再到期清除後 B 的預覽仍失效，額外寫入為零', async () => {
  const file = join(folder(), 'cross-activity.sqlite'),
    h = fixture(file),
    A = await h.settled(),
    B = await h.settled()
  const book = sample(),
    tab = book.tabs[0]
  tab.rows[2][2].userEnteredValue = { stringValue: 'CPU' }
  h.sheets.save(book)
  const pb = await h.writer.preview(h.owner, B.aid, '1')
  // B 曾讀 C、D。A 寫入 C、E，稍後兩個表頭回到 B 的原位置。
  tab.rows[0][4] = tab.rows[0][3]
  tab.rows[0][3] = { userEnteredValue: { stringValue: '備註' } }
  delete tab.rows[2][2].userEnteredValue
  h.sheets.save(book)
  const pa = await h.writer.preview(h.owner, A.aid, '1')
  const write = vi.spyOn(h.sheets, 'write')
  await h.writer.confirm(h.owner, A.aid, '1', pa.key, [])
  expect(write.mock.calls[0][3].map((c) => c.col)).toEqual([2, 4])
  const live = await h.sheets.read(h.owner, book.id)
  live.tabs[0].rows[0][3] = live.tabs[0].rows[0].pop()!
  h.sheets.save(live)
  write.mockClear()
  expect(h.change('remove', A.aid, 0).message).toBe('已移除')
  expect(write).not.toHaveBeenCalled()
  h.db.close()
  const db = new Store(file),
    sheets = new FixtureSheets(db, sample()),
    writer = new Writeback(db, sheets)
  cleanup.push(() => db.close())
  let now = 1000
  const life = new Retention(db, () => now)
  const restartedWrites = vi.spyOn(sheets, 'write')
  await writer.recover()
  await expect(
    writer.confirm(h.owner, A.aid, '1', pa.key, []),
  ).rejects.toThrow()
  await expect(writer.retry(h.owner, A.aid, '1')).rejects.toThrow()
  expect(
    life.change(h.owner, 'restore', id(), [target(A.aid, 1)])[0].message,
  ).toBe('已還原')
  await writer.confirm(h.owner, A.aid, '1', pa.key, [])
  await writer.retry(h.owner, A.aid, '1')
  expect(
    life.change(h.owner, 'remove', id(), [target(A.aid, 2)])[0].message,
  ).toBe('已移除')
  now += retentionMs
  life.sweep((error) => {
    throw error
  })
  expect(db.one('SELECT id FROM activities WHERE id=?', A.aid)).toBeUndefined()
  await expect(writer.confirm(h.owner, B.aid, '1', pb.key, [])).rejects.toThrow(
    '過期',
  )
  expect(restartedWrites).not.toHaveBeenCalled()
  expect(await sheets.read(h.owner, book.id)).toEqual(live)
})

it('唯讀預覽若跨越移除或還原，結果不覆蓋已保存的逐題狀態', async () => {
  const h = fixture(),
    { aid } = await h.settled()
  const p = await h.writer.preview(h.owner, aid, '1')
  await h.writer.confirm(h.owner, aid, '1', p.key, [])
  const original = h.sheets.read.bind(h.sheets)
  for (const version of [0, 2]) {
    const reading = Promise.withResolvers<void>(),
      go = Promise.withResolvers<void>()
    vi.spyOn(h.sheets, 'read').mockImplementationOnce(async (...args) => {
      reading.resolve()
      await go.promise
      return original(...args)
    })
    const preview = h.writer.preview(h.owner, aid, '1')
    await reading.promise
    h.change('remove', aid, version)
    if (version === 2) h.change('restore', aid, 3)
    go.resolve()
    await expect(preview).rejects.toThrow()
    expect(
      h.db.one(
        "SELECT preview,progress FROM questions WHERE aid=? AND q='1'",
        aid,
      ),
    ).toEqual({ preview: null, progress: '已確認寫入' })
    if (version === 0) h.change('restore', aid, 1)
  }
})

it('寫入已抵達但尚未讀回時取得 SQLite 副本，服務重啟對帳並清除中斷工作', async () => {
  const dir = folder(),
    h = fixture(join(dir, 'running.sqlite'))
  const { aid } = await h.settled(),
    other = await h.settled()
  const p = await h.writer.preview(h.owner, aid, '1')
  const arrived = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>()
  const original = h.sheets.write.bind(h.sheets)
  vi.spyOn(h.sheets, 'write').mockImplementationOnce(async (...args) => {
    await original(...args)
    arrived.resolve()
    await resume.promise
  })
  const work = h.writer.confirm(h.owner, aid, '1', p.key, [])
  await arrived.promise
  const otherWait = h.writer
    .confirm(h.owner, other.aid, '1', '未經確認', [])
    .catch((e) => e)
  expect(
    h.db.all('SELECT state FROM write_jobs ORDER BY rowid').map((r) => r.state),
  ).toEqual(['執行中', '排隊中'])
  const file = join(dir, 'restart.sqlite')
  h.db.run('VACUUM INTO ?', file)
  const reopened = new Store(file)
  try {
    const sheets = new FixtureSheets(reopened, sample())
    const writes = vi.spyOn(sheets, 'write'),
      reads = vi.spyOn(sheets, 'read')
    await new Writeback(reopened, sheets).recover()
    expect(reads).toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(reopened.all('SELECT * FROM write_jobs')).toEqual([])
    const find = (a: string) =>
      reopened.one(
        "SELECT published,progress FROM questions WHERE aid=? AND q='1'",
        a,
      )
    expect(find(aid)).toEqual({ published: 1, progress: '已確認寫入' })
    expect(find(other.aid)).toEqual({ published: 0, progress: '待寫入' })
  } finally {
    reopened.close()
    resume.resolve()
    await Promise.all([work, otherWait])
  }
})

it('已還原的同一請求只重送當時換發的碼；舊確認不重新移除', async () => {
  const h = fixture(),
    aid = await h.activity()
  h.member(aid, '123456789')
  h.change('remove', aid, 0, 'first-remove')
  const response = h.change('restore', aid, 1, 'first-restore')
  h.member(aid, '123456788')
  h.quiz.control(h.owner, aid, 'open')
  expect(h.change('restore', aid, 1, 'first-restore')).toEqual(response)
  expect(h.change('remove', aid, 0, 'first-remove').message).toBe(
    '在我的活動中',
  )
  expect(h.quiz.activity(aid).phase).toBe('開放中')
})

it('開場、送答、截止與移除依生效順序決定資格', async () => {
  const h = fixture(),
    aid = await h.activity(),
    a = h.member(aid, '123456789')
  h.quiz.control(h.owner, aid, 'open')
  expect(h.change('remove', aid, 0).message).toContain('截止')
  h.submit(a.session, aid, 'CPU')
  h.quiz.control(h.owner, aid, 'close')
  expect(h.change('remove', aid, 0).message).toContain('待寫入')
  const item = h.db.one('SELECT rank,gid FROM submissions WHERE aid=?', aid)
  expect(item).toEqual({ rank: 1, gid: a.session.gid })
  const second = await h.activity(),
    b = h.member(second, '123456788')
  h.change('remove', second, 0)
  expect(() => h.quiz.control(h.owner, second, 'open')).toThrow('移除')
  expect(() => h.submit(b.session, second, 'late')).toThrow('移除')
  expect(h.db.all('SELECT * FROM submissions WHERE aid=?', second)).toEqual([])
})
