import { describe, it, expect, vi } from 'vitest'
import { sample, setup, url } from './support'
import { parseBook, type Book, type Tab } from '../server/sheets'
const variants: [string, (b: Book, t: Tab) => unknown, RegExp][] = [
  ['缺少表頭', (_, t) => t.rows[0].pop(), /搶答勝組/],
  [
    '缺號',
    (_, t) => {
      t.rows[2][0] = {}
    },
    /第 3 列/,
  ],
  [
    '重號',
    (_, t) => {
      t.rows[3][0] = { userEnteredValue: { stringValue: '０１' } }
    },
    /重複/,
  ],
  [
    '公式顯示為整數',
    (_, t) => {
      t.rows[2][0] = {
        userEnteredValue: { formulaValue: '=1' },
        formattedValue: '1',
      }
    },
    /第 3 列/,
  ],
  ['重複表格', (_, t) => t.rows.push(t.rows[0]), /多份/],
  [
    '只有格式或空白',
    (_, t) => {
      t.rows = t.rows.slice(0, 2)
    },
    /沒有有效/,
  ],
  [
    '題組',
    (_, t) =>
      t.merges.push({
        startRowIndex: 2,
        endRowIndex: 4,
        startColumnIndex: 0,
        endColumnIndex: 1,
      }),
    /題組/,
  ],
  [
    '唯讀',
    (b) => {
      b.editable = false
    },
    /讀取權限/,
  ],
  [
    '勝組格受保護',
    (_, t) =>
      t.protections.push({
        range: {
          startRowIndex: 2,
          endRowIndex: 3,
          startColumnIndex: 3,
          endColumnIndex: 4,
        },
      }),
    /題號 1.*D3/,
  ],
]
describe('四欄範本 v1', () => {
  it.each(variants)(
    '%s 在預覽指出原因並保留原格',
    async (_, change, expected) => {
      const b = sample()
      change(b, b.tabs[0])
      const before = structuredClone(b)
      expect(() => parseBook(b, 1)).toThrow(expected)
      expect(b).toEqual(before)
      const h = setup()
      try {
        const aid = await h.activity()
        h.sheets.save(b)
        await expect(h.quiz.import(h.owner, aid, url, 1)).rejects.toThrow(
          expected,
        )
        expect(() => h.quiz.control(h.owner, aid, 'open')).toThrow('匯入')
        expect(await h.sheets.read(h.owner, b.id)).toEqual(before)
      } finally {
        h.db.close()
      }
    },
  )
  it('忽略說明列、格式空列，保留數字原標示與分頁', () => {
    const b = sample()
    b.tabs[1].rows.push([])
    b.tabs[1].rows[0][0].formattedValue = ' 題號 '
    b.tabs[1].rows[2][0] = {
      userEnteredValue: { numberValue: 1 },
      formattedValue: '01',
    }
    const found = parseBook(b, 2)
    expect(found.tab.title).toBe('另一分頁')
    expect(found.questions.map((x) => x.label)).toEqual([
      '01',
      '2',
      '3',
      '4',
      '5',
      '6',
    ])
    expect(() => parseBook(b, 999)).toThrow('分頁')
  })
  it('重新匯入不累加；失敗版不能開場，前版保留', async () => {
    const h = setup()
    try {
      const aid = await h.activity()
      await h.quiz.import(h.owner, aid, url, 2)
      await expect(h.quiz.import(h.owner, aid, url, 777)).rejects.toThrow(
        '分頁',
      )
      expect(h.quiz.view(aid, { teacher: h.owner }).questions).toHaveLength(6)
      expect(JSON.parse(h.quiz.activity(aid).source).tab).toBe(2)
      expect(() => h.quiz.control(h.owner, aid, 'open')).toThrow('匯入')
    } finally {
      h.db.close()
    }
  })
})

it('移欄、合併及來源有上場資料時，只公開原標示與本場資格', async () => {
  const h = setup()
  try {
    const aid = await h.activity(),
      member = h.member(aid, '100000001')
    const b = sample(),
      tab = b.tabs[0]
    tab.rows = tab.rows.filter((_, i) => [0, 1, 2, 4, 6].includes(i))
    for (const r of tab.rows) r.splice(3, 0, {})
    tab.merges.push({
      startRowIndex: 2,
      endRowIndex: 3,
      startColumnIndex: 2,
      endColumnIndex: 4,
    })
    tab.rows[2][0] = { userEnteredValue: { stringValue: '01' } }
    tab.rows[2][2].userEnteredValue = { stringValue: '上場勝答' }
    h.sheets.save(b)
    const parsed = parseBook(b, 1)
    expect(parsed.questions.map((q) => q.label)).toEqual(['01', '3', '5'])
    expect(parsed.questions[0].targets.map((t) => t.range)).toEqual([
      'C3:D3',
      'E3',
    ])
    await h.quiz.import(h.owner, aid, url, 1)
    h.quiz.control(h.owner, aid, 'open')
    expect(h.quiz.view(aid, member.session).questions).toEqual(
      ['01', '3', '5'].map((label) => ({
        label,
        q: String(Number(label)),
        ownAnswer: null,
      })),
    )
    expect(await h.sheets.read(h.owner, b.id)).toEqual(b)
  } finally {
    h.db.close()
  }
})

it('較早匯入的慢回應不會使較新但失敗的選擇突然可開場', async () => {
  const h = setup()
  try {
    const aid = await h.activity()
    let finish!: (book: Book) => void
    vi.spyOn(h.sheets, 'read').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const slow = h.quiz.import(h.owner, aid, url, 2)
    await expect(h.quiz.import(h.owner, aid, url, 999)).rejects.toThrow('分頁')
    finish(sample())
    await expect(slow).rejects.toThrow('較新')
    expect(h.quiz.view(aid, { teacher: h.owner }).ready).toBe(false)
    expect(h.quiz.view(aid, { teacher: h.owner }).source?.tab).toBe(1)
    expect(() => h.quiz.control(h.owner, aid, 'open')).toThrow('確認匯入')
  } finally {
    h.db.close()
  }
})
