import { check, Problem, type Store } from './db'
export type Value = {
  stringValue?: string
  numberValue?: number
  boolValue?: boolean
  formulaValue?: string
}
export type Cell = {
  userEnteredValue?: Value
  formattedValue?: string
  userEnteredFormat?: unknown
  textFormatRuns?: unknown[]
}
export interface Range {
  startRowIndex?: number
  endRowIndex?: number
  startColumnIndex?: number
  endColumnIndex?: number
}
export interface Tab {
  id: number
  title: string
  rows: Cell[][]
  merges: Range[]
  protections: {
    range: Range
    unprotectedRanges?: Range[]
    warningOnly?: boolean
    requestingUserCanEdit?: boolean
  }[]
}
export interface Book {
  id: string
  title: string
  editable: boolean
  tabs: Tab[]
}
export interface Target {
  row: number
  col: number
  range: string
  address: string
  value: Value | null
}
export interface Question {
  q: string
  label: string
  stem: string
  targets: Target[]
}
export interface Edit {
  row: number
  col: number
  text: string
}
export interface Sheets {
  read(owner: string, book: string): Promise<Book>
  write(owner: string, book: string, tab: number, edits: Edit[]): Promise<void>
}
export function bookId(url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Problem('請貼上 Google 試算表網址')
  }
  const m = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/)
  check(
    u.protocol === 'https:' && u.hostname === 'docs.google.com' && m,
    '請貼上 Google 試算表網址',
  )
  return m[1]
}
export function address(row: number, col: number) {
  let name = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name + (row + 1)
}
function covers(r: Range, i: number, j: number) {
  return (
    i >= (r.startRowIndex ?? 0) &&
    i < (r.endRowIndex ?? Infinity) &&
    j >= (r.startColumnIndex ?? 0) &&
    j < (r.endColumnIndex ?? Infinity)
  )
}
const text = (c?: Cell) =>
  c?.formattedValue ??
  String(
    c?.userEnteredValue?.stringValue ?? c?.userEnteredValue?.numberValue ?? '',
  )
const headers = ['題號', '題目', '作答', '搶答勝組']
function target(t: Tab, i: number, j: number): Target {
  const m = t.merges.find((r) => covers(r, i, j))
  const row = m ? (m.startRowIndex ?? 0) : i,
    col = m ? (m.startColumnIndex ?? 0) : j
  const a = address(row, col)
  const range = m
    ? a + ':' + address(m.endRowIndex! - 1, m.endColumnIndex! - 1)
    : a
  for (const p of t.protections) {
    if (
      !p.warningOnly &&
      !p.requestingUserCanEdit &&
      covers(p.range, row, col) &&
      !p.unprotectedRanges?.some((r) => covers(r, row, col))
    )
      throw new Problem('目標格受保護 ' + a)
  }
  return {
    row,
    col,
    range,
    address: a,
    value: t.rows[row]?.[col]?.userEnteredValue ?? null,
  }
}
export function parseBook(book: Book, tabId: number, onlyQuestion?: string) {
  const t = book.tabs.find((t) => t.id === tabId)
  check(t, '找不到選定分頁')
  check(book.editable, '試算表僅有讀取權限')
  const candidates = t.rows
    .map((cells, i) => ({ labels: cells.map((c) => text(c).trim()), i }))
    .filter((r) => headers.every((h) => r.labels.includes(h)))
  if (!candidates.length) {
    const labels =
      t.rows
        .map((row) => row.map((c) => text(c).trim()))
        .sort(
          (a, b) =>
            headers.filter((h) => b.includes(h)).length -
            headers.filter((h) => a.includes(h)).length,
        )[0] ?? []
    throw new Problem(
      '缺少表頭：' + headers.filter((h) => !labels.includes(h)).join('、'),
    )
  }
  check(candidates.length === 1, '同一分頁有多份題表')
  const { labels, i: head } = candidates[0]
  for (const h of headers)
    check(labels.filter((x) => x === h).length === 1, '重複表頭：' + h)
  const [num, stem, ans, win] = headers.map((h) => labels.indexOf(h))
  const questions: Question[] = [],
    seen = new Set<string>()
  for (let i = head + 1; i < t.rows.length; i++) {
    const cells = t.rows[i],
      label = text(cells[num]).trim(),
      statement = text(cells[stem]).trim()
    if (!label && !statement) continue
    // 範本的說明列可橫跨題號及題目；單題必須獨占一個作答位置。
    if (t.merges.some((m) => covers(m, i, num) && covers(m, i, stem))) continue
    if (
      !statement &&
      label &&
      !/^\s*[\d０-９]+\s*$/.test(label) &&
      cells.filter((c) => text(c)).length === 1
    )
      continue
    const raw = cells[num]?.userEnteredValue
    const normalized = (
      raw?.numberValue !== undefined
        ? String(raw.numberValue)
        : (raw?.stringValue?.trim() ?? '')
    ).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248))
    const valid = /^\d+$/.test(normalized) && BigInt(normalized) > 0n
    if (onlyQuestion !== undefined && !valid) continue
    check(valid, '第 ' + (i + 1) + ' 列題號缺少或無效')
    const q = BigInt(normalized).toString()
    if (onlyQuestion !== undefined && onlyQuestion !== q) continue
    check(!seen.has(q), '第 ' + (i + 1) + ' 列題號重複：' + label)
    seen.add(q)
    const numMerge = t.merges.find((r) => covers(r, i, num))
    const end = numMerge?.endRowIndex ?? i + 1
    const targets = [ans, win].map((col) => {
      try {
        const a = target(t, i, col)
        const m = t.merges.find((r) => covers(r, i, col))
        const bottom = m?.endRowIndex ?? i + 1
        check(
          a.row === i && (col !== ans || bottom >= end),
          '題組或跨題目標無法對應單題',
        )
        if (m) {
          check(
            !covers(m, i, num) && !covers(m, i, stem),
            '目標範圍與題號或題幹重疊',
          )
          for (let r = i + 1; r < bottom; r++)
            check(!text(t.rows[r]?.[num]).trim(), '合併目標跨越其他題號')
        }
        return a
      } catch (e) {
        throw new Problem('題號 ' + label + '：' + (e as Error).message)
      }
    })
    check(targets[0].address !== targets[1].address, '兩個目標格重疊：' + label)
    questions.push({ q, label, stem: statement, targets })
    i = end - 1
  }
  check(
    questions.length,
    onlyQuestion ? '原題已變更，暫停回寫' : '沒有有效單題',
    onlyQuestion ? 409 : 400,
  )
  return { tab: t, questions }
}

export class FixtureSheets implements Sheets {
  constructor(
    readonly db: Store,
    readonly initial: Book,
  ) {}
  async read(_owner: string, book: string): Promise<Book> {
    check(book === this.initial.id, '找不到試算表', 404)
    const row = this.db.one(
      'SELECT snapshot FROM fixture_books WHERE book=?',
      book,
    )
    return row ? JSON.parse(row.snapshot) : structuredClone(this.initial)
  }
  save(book: Book) {
    this.db.run(
      'INSERT OR REPLACE INTO fixture_books VALUES(?,?)',
      book.id,
      JSON.stringify(book),
    )
  }
  async write(owner: string, id: string, tabId: number, edits: Edit[]) {
    const book = await this.read(owner, id)
    const tab = book.tabs.find((t) => t.id === tabId)!
    check(book.editable, '試算表僅有讀取權限')
    for (const e of edits) {
      target(tab, e.row, e.col)
      const cell = (tab.rows[e.row][e.col] ??= {})
      cell.userEnteredValue = { stringValue: e.text }
      cell.formattedValue = e.text
      delete cell.textFormatRuns
    }
    this.save(book)
  }
}
