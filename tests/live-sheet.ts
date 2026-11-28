import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { randomInt } from 'node:crypto'
import { Store, dbPath } from '../server/db'
import { GoogleSheets } from '../server/google'
import {
  address,
  bookId,
  parseBook,
  type Sheets,
  type Tab,
} from '../server/sheets'
import { Quiz } from '../server/quiz'
import { Writeback } from '../server/writeback'
import { sample } from './support'
import { assertSeededCellFormat } from './sheet-format'

if (existsSync('.env')) loadEnvFile('.env')
const url = process.env.GOOGLE_TEST_COPY_URL
const owner = process.env.TEACHER_NAME
const required = [
  'GOOGLE_TEST_COPY_URL',
  'TEACHER_NAME',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'QUIZ_TOKEN_KEY',
]
const missing = required.filter(
  (k) => !process.env[k] || process.env[k]!.includes('<'),
)
if (!url || !owner || missing.length || !existsSync(dbPath())) {
  console.log(
    '待執行：需要已完成 Google 授權的教師資料庫與專用可編輯副本。缺少的設定名稱：' +
      missing.join('、'),
  )
  process.exit(2)
}
const book = bookId(url)
const credentials = new Store(dbPath()),
  db = new Store(':memory:')
try {
  const google = new GoogleSheets(credentials)
  assert(
    credentials.one('SELECT google FROM teachers WHERE name=?', owner)?.google,
    '請先由教師頁完成 Google OAuth',
  )
  const original = await google.read(owner, book)
  assert(original.editable, '測試副本須可編輯')
  const version = sample(),
    stamp = Date.now()
  const reserved = new Set(original.tabs.map((t) => t.id))
  const tabs = version.tabs.map((base) => {
    let id = randomInt(1, 2 ** 30)
    while (reserved.has(id)) id = randomInt(1, 2 ** 30)
    reserved.add(id)
    return { base, id, title: '驗收-v1-' + stamp + '-' + base.title }
  })
  // 重置兩個同簿分頁。單批建立，絕不覆寫既有分頁；保留結果供團隊核對。
  await google.batchUpdate(
    owner,
    book,
    tabs.flatMap(({ base, id, title }) => [
      { addSheet: { properties: { sheetId: id, title } } },
      {
        updateCells: {
          start: { sheetId: id, rowIndex: 0, columnIndex: 0 },
          fields: 'userEnteredValue,userEnteredFormat,textFormatRuns',
          rows: base.rows.map((row) => ({
            values: row.map(({ formattedValue, ...editable }) => editable),
          })),
        },
      },
      ...base.merges.map((range) => ({
        mergeCells: {
          range: { sheetId: id, ...range },
          mergeType: 'MERGE_ALL',
        },
      })),
      ...base.protections.map((p) => ({
        addProtectedRange: {
          protectedRange: { ...p, range: { sheetId: id, ...p.range } },
        },
      })),
    ]),
  )
  const reset = await google.read(owner, book)
  assert.equal(reset.title, original.title)
  for (const { base, id, title } of tabs) {
    const { tab, questions } = parseBook(reset, id)
    assert.equal(tab.title, title)
    assert.deepEqual(
      questions.map((q) => q.label),
      parseBook(version, base.id).questions.map((q) => q.label),
    )
    assert.equal(tab.protections.length, base.protections.length)
    assert.deepEqual(
      tab.merges.map(
        ({
          startRowIndex = 0,
          endRowIndex,
          startColumnIndex = 0,
          endColumnIndex,
        }) => [startRowIndex, endRowIndex, startColumnIndex, endColumnIndex],
      ),
      base.merges.map((r) => [
        r.startRowIndex ?? 0,
        r.endRowIndex,
        r.startColumnIndex ?? 0,
        r.endColumnIndex,
      ]),
    )
    for (const [i, row] of base.rows.entries())
      for (const [j, cell] of row.entries()) {
        const real = tab.rows[i]?.[j]
        assert.deepEqual(real?.userEnteredValue, cell.userEnteredValue)
        if (cell.userEnteredFormat)
          assertSeededCellFormat(
            real?.userEnteredFormat,
            cell.userEnteredFormat,
            `${title}!${address(i, j)}`,
          )
      }
  }
  const selected = tabs[0],
    originalTab = reset.tabs.find((t) => t.id === selected.id)!
  let writes = 0
  const adapter: Sheets = {
    read: (o, b) => google.read(o, b),
    async write(o, b, t, edits) {
      assert.equal(b, book)
      assert.equal(t, selected.id)
      writes++
      await google.write(o, b, t, edits)
    },
  }
  const quiz = new Quiz(db, adapter),
    writer = new Writeback(db, adapter)
  db.run(
    'INSERT INTO teachers(name,salt,hash) VALUES(?,?,?)',
    owner,
    'unused',
    'unused',
  )
  const aid = quiz.create(owner, selected.title)
  await quiz.import(owner, aid, url, selected.id)
  assert.equal(quiz.view(aid, { teacher: owner }).questions.length, 6)
  function member(leader: string) {
    db.session(null, aid)
    const s = db.one('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1')!
    quiz.join(s, leader, undefined)
    return db.one('SELECT * FROM sessions WHERE token=?', s.token)!
  }
  const a = member('100000001'),
    b = member('100000002')
  const seq = () =>
    Number(db.run('INSERT INTO inbox DEFAULT VALUES').lastInsertRowid)
  quiz.control(owner, aid, 'open')
  assert.throws(() => quiz.submit(a, aid, '1', '　', seq()), /空白/)
  quiz.submit(b, aid, '1', 'CPU', seq())
  quiz.submit(a, aid, '1', '中央處理器', seq())
  assert.equal(quiz.submit(b, aid, '1', 'CPU', seq()).status, '先前已收件')
  quiz.control(owner, aid, 'close')
  const q = quiz.view(aid, { teacher: owner }).questions[0]
  assert.deepEqual(
    q.submissions?.map((s) => [s.rank, s.label]),
    [
      [1, 'G02'],
      [2, 'G01'],
    ],
  )
  assert.equal(q.winner, 'G02')
  assert.equal(quiz.view(aid, a).questions[0].winningAnswer, undefined)
  const p = await writer.preview(owner, aid, '1')
  assert.deepEqual(
    p.slots.map((s) => [s.address, s.value]),
    [
      ['C3', null],
      ['D3', null],
    ],
  )
  await writer.confirm(owner, aid, '1', p.key, [])
  assert.equal(quiz.view(aid, a).questions[0].winningAnswer, 'CPU')
  await writer.retry(owner, aid, '1')
  assert.equal(writes, 1)
  const after = await google.read(owner, book),
    work = after.tabs.find((t) => t.id === selected.id) as Tab
  for (const [col, expected] of [
    [2, 'CPU'],
    [3, 'G02'],
  ] as const) {
    const cell = work.rows[2][col]
    assert.deepEqual(cell.userEnteredValue, { stringValue: expected })
    assert.deepEqual(
      cell.userEnteredFormat,
      originalTab.rows[2][col].userEnteredFormat,
    )
    work.rows[2][col] = originalTab.rows[2][col]
  }
  for (const t of tabs)
    assert.deepEqual(
      after.tabs.find((x) => x.id === t.id),
      reset.tabs.find((x) => x.id === t.id),
    )
  console.log(
    '實表通過：' +
      selected.title +
      '，六題；2 筆有效、乙第一，C3 純文字 CPU、D3 純文字 G02；兩分頁其餘格與整格格式一致，重試新增寫入 0 次。',
  )
} finally {
  credentials.close()
  db.close()
}
