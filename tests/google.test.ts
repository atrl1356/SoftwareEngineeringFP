import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { GoogleSheets } from '../server/google'
import { assertSeededCellFormat } from './sheet-format'
import { setup } from './support'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const seededColor = { red: 0.9, green: 0.95, blue: 1 }
const returnedColor = { red: 0.8980392, green: 0.9490196, blue: 1 }

it('實表驗收接受 Sheets 讀回的 8 位元底色色階', () => {
  expect(() =>
    assertSeededCellFormat(
      {
        backgroundColor: returnedColor,
        backgroundColorStyle: { rgbColor: returnedColor },
      },
      { backgroundColor: seededColor },
      '驗收!C3',
    ),
  ).not.toThrow()
})

it('實表驗收仍拒絕缺漏、變色與被改動的其他格式', () => {
  const expected = {
    backgroundColor: seededColor,
    textFormat: { italic: true },
  }
  expect(() =>
    assertSeededCellFormat(
      { textFormat: { italic: true } },
      expected,
      '驗收!C3',
    ),
  ).toThrow('缺少預期的 RGB 底色')
  expect(() =>
    assertSeededCellFormat(
      {
        backgroundColor: returnedColor,
        backgroundColorStyle: {
          rgbColor: { ...returnedColor, red: 0.89411765 },
        },
        textFormat: { italic: true },
      },
      expected,
      '驗收!C3',
    ),
  ).toThrow('底色 red')
  expect(() =>
    assertSeededCellFormat(
      { backgroundColor: returnedColor, textFormat: { italic: false } },
      expected,
      '驗收!C3',
    ),
  ).toThrow('格式不符')
})

it('OAuth state 單次有效、更新憑證加密保存，Sheets API 寫入遮罩只包含原始字串值', async () => {
  const h = setup()
  try {
    for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
      vi.stubEnv(name, randomBytes(10).toString('hex'))
    vi.stubEnv(
      'GOOGLE_REDIRECT_URI',
      'http://localhost:3000/api/google/callback',
    )
    vi.stubEnv('QUIZ_TOKEN_KEY', randomBytes(32).toString('hex'))
    const refresh = randomBytes(24).toString('hex'),
      calls: { url: string; data: any }[] = []
    const mock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('oauth2.googleapis.com'))
        return Response.json({
          access_token: 'test-access',
          refresh_token: refresh,
        })
      if (url.includes('drive/v3'))
        return Response.json({ capabilities: { canEdit: true } })
      if (url.endsWith(':batchUpdate')) {
        calls.push({ url, data: JSON.parse(String(init.body)) })
        return Response.json({ replies: [] })
      }
      return Response.json({
        properties: { title: '學習單' },
        sheets: [
          {
            properties: { sheetId: 19, title: '修訂版' },
            data: [{ rowData: [] }],
          },
        ],
      })
    })
    vi.stubGlobal('fetch', mock)
    const g = new GoogleSheets(h.db)
    await expect(g.read(h.owner, 'book')).rejects.toThrow('先連結')
    expect(mock).not.toHaveBeenCalled()
    const flow = g.authorize(h.owner)
    expect(new URL(flow.url).searchParams.get('state')).toBe(flow.state)
    await expect(g.callback('invalid', 'test-code')).rejects.toThrow('過期')
    await g.callback(flow.state, 'test-code')
    await expect(g.callback(flow.state, 'test-code')).rejects.toThrow('過期')
    expect(h.db.one('SELECT google FROM teachers')?.google).not.toContain(
      refresh,
    )
    const book = await g.read(h.owner, 'book')
    expect(book.tabs[0]).toMatchObject({ id: 19, title: '修訂版' })
    await g.write(h.owner, 'book', 19, [
      { row: 2, col: 3, text: '=1+1' },
      { row: 2, col: 7, text: 'G02' },
    ])
    expect(calls[0].data.requests.map((r: any) => r.updateCells)).toEqual(
      [
        ['=1+1', 3],
        ['G02', 7],
      ].map(([value, col]) => ({
        start: { sheetId: 19, rowIndex: 2, columnIndex: col },
        fields: 'userEnteredValue',
        rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
      })),
    )
  } finally {
    h.db.close()
  }
})
