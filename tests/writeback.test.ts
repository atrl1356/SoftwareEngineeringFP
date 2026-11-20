import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup, sample } from './support'
import { Problem, Store } from '../server/db'
import { FixtureSheets } from '../server/sheets'
import { Writeback } from '../server/writeback'
it.each(['CPU', '001', '=1+1', ' 001 '])(
  '只更新兩個目標字串 %s，保留整格和非目標格',
  async (answer) => {
    const h = setup()
    try {
      const { aid, a } = await h.settled(answer)
      const before = await h.sheets.read(h.owner, sample().id),
        tab = before.tabs[0]
      tab.rows.forEach((r) =>
        r.splice(2, 0, {
          userEnteredValue: { stringValue: '備註' },
          textFormatRuns: [{ startIndex: 0 }],
        }),
      )
      // 作答移到 D，勝組移至 F，使用 D:E 合併區。
      tab.rows.forEach((r) => r.splice(4, 0, {}))
      tab.merges.push({
        startRowIndex: 2,
        endRowIndex: 3,
        startColumnIndex: 3,
        endColumnIndex: 5,
      })
      tab.rows[2][3].userEnteredValue = { stringValue: '舊文字與連結' }
      tab.rows[2][3].textFormatRuns = [
        { startIndex: 0, format: { bold: true } },
        { startIndex: 3, format: { link: { uri: 'https://example.org' } } },
      ]
      h.sheets.save(before)
      const p = await h.writer.preview(h.owner, aid, '1')
      expect(p.slots.map((s) => s.range)).toEqual(['D3:E3', 'F3'])
      await h.writer.confirm(h.owner, aid, '1', p.key, ['D3'])
      for (const [col, s] of [
        [3, answer],
        [5, a.group.label],
      ] as const) {
        tab.rows[2][col].userEnteredValue = { stringValue: s }
        tab.rows[2][col].formattedValue = s
        delete tab.rows[2][col].textFormatRuns
      }
      expect(await h.sheets.read(h.owner, before.id)).toEqual(before)
      await expect(h.writer.preview(h.owner, aid, '2')).rejects.toThrow('略過')
    } finally {
      h.db.close()
    }
  },
)
it('過期預覽不公布；公式覆蓋需同意；有效確認後拒寫仍公布', async () => {
  const h = setup()
  try {
    const { aid, a } = await h.settled(),
      b = sample(),
      p = await h.writer.preview(h.owner, aid, '1')
    b.tabs[0].rows[2][3] = {
      userEnteredValue: { formulaValue: '=""' },
      formattedValue: '',
    }
    h.sheets.save(b)
    await expect(
      h.writer.confirm(h.owner, aid, '1', p.key, []),
    ).rejects.toThrow('過期')
    expect(h.quiz.view(aid, a.session).questions[0]).not.toHaveProperty(
      'winningAnswer',
    )
    const next = await h.writer.preview(h.owner, aid, '1')
    await expect(
      h.writer.confirm(h.owner, aid, '1', next.key, []),
    ).rejects.toThrow('同意')
    vi.spyOn(h.sheets, 'write').mockRejectedValueOnce(new Problem('撤權', 403))
    await expect(
      h.writer.confirm(h.owner, aid, '1', next.key, ['D3']),
    ).rejects.toThrow('撤權')
    expect(h.quiz.view(aid, a.session).questions[0].winningAnswer).toBe('CPU')
    expect(h.quiz.view(aid, { teacher: h.owner }).questions[0].progress).toBe(
      '失敗',
    )
    expect(await h.sheets.read(h.owner, b.id)).toEqual(b)
    await h.writer.retry(h.owner, aid, '1')
  } finally {
    h.db.close()
  }
})
it.each(['不同文字', 'CPU'])(
  '跨場改寫後，即使%s也攔截舊場重試',
  async (other) => {
    const h = setup()
    try {
      const A = await h.settled(),
        B = await h.settled(other)
      const write = vi
        .spyOn(h.sheets, 'write')
        .mockRejectedValueOnce(Error('逾時'))
      const p = await h.writer.preview(h.owner, A.aid, '1')
      await expect(
        h.writer.confirm(h.owner, A.aid, '1', p.key, []),
      ).rejects.toThrow('逾時')
      const b = await h.writer.preview(h.owner, B.aid, '1')
      await h.writer.confirm(h.owner, B.aid, '1', b.key, [])
      const snapshot = await h.sheets.read(h.owner, sample().id)
      write.mockClear()
      await expect(h.writer.retry(h.owner, A.aid, '1')).rejects.toThrow(
        '重新確認',
      )
      expect(write).not.toHaveBeenCalled()
      expect(await h.sheets.read(h.owner, snapshot.id)).toEqual(snapshot)
    } finally {
      h.db.close()
    }
  },
)
it('一格已符合只補另一格，讀回才完成', async () => {
  const h = setup()
  try {
    const A = await h.settled(),
      write = h.sheets.write.bind(h.sheets),
      p = await h.writer.preview(h.owner, A.aid, '1')
    const spy = vi
      .spyOn(h.sheets, 'write')
      .mockImplementationOnce(async (o, b, t, edits) => {
        await write(o, b, t, edits.slice(0, 1))
        throw Error('斷線')
      })
    await expect(
      h.writer.confirm(h.owner, A.aid, '1', p.key, []),
    ).rejects.toThrow()
    await h.writer.retry(h.owner, A.aid, '1')
    expect(spy.mock.calls[1][3]).toEqual([
      expect.objectContaining({ col: 3, text: A.a.group.label }),
    ])
    expect(h.quiz.view(A.aid, { teacher: h.owner }).questions[0].progress).toBe(
      '已確認寫入',
    )
  } finally {
    h.db.close()
  }
})
it('已寫兩格回應遺失，跨程序資料檔恢復且不再次送寫', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-write-')),
    file = join(dir, 'db.sqlite'),
    h = setup(file)
  try {
    const A = await h.settled(),
      p = await h.writer.preview(h.owner, A.aid, '1'),
      write = h.sheets.write.bind(h.sheets)
    vi.spyOn(h.sheets, 'write').mockImplementationOnce(async (...args) => {
      await write(...args)
      throw Error('逾時')
    })
    await expect(
      h.writer.confirm(h.owner, A.aid, '1', p.key, []),
    ).rejects.toThrow()
    expect(h.quiz.view(A.aid, { teacher: h.owner }).questions[0].progress).toBe(
      '待核實',
    )
    h.db.close()
    const db = new Store(file)
    try {
      const sheets = new FixtureSheets(db, sample()),
        newWrites = vi.spyOn(sheets, 'write')
      await new Writeback(db, sheets).recover()
      expect(
        db.one(
          "SELECT progress,published FROM questions WHERE aid=? AND q='1'",
          A.aid,
        ),
      ).toEqual({ progress: '已確認寫入', published: 1 })
      expect(newWrites).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('另一場只改寫重疊的一格，舊確認仍須作廢', async () => {
  const h = setup()
  try {
    const A = await h.settled('OLD'),
      B = await h.settled('NEW'),
      pa = await h.writer.preview(h.owner, A.aid, '1')
    vi.spyOn(h.sheets, 'write').mockRejectedValueOnce(Error('逾時'))
    await expect(
      h.writer.confirm(h.owner, A.aid, '1', pa.key, []),
    ).rejects.toThrow()
    const b = sample()
    // B 在勝組欄移到 E 之後寫 C、E；A 當初核可的是 C、D。
    const row = b.tabs[0].rows[0]
    row[4] = row[3]
    row[3] = { userEnteredValue: { stringValue: '備註' } }
    h.sheets.save(b)
    const p = await h.writer.preview(h.owner, B.aid, '1')
    const spy = vi.mocked(h.sheets.write)
    await h.writer.confirm(h.owner, B.aid, '1', p.key, [])
    expect(spy.mock.lastCall?.[3].map((e) => e.col)).toEqual([2, 4])
    const moved = await h.sheets.read(h.owner, b.id)
    moved.tabs[0].rows[0][3] = moved.tabs[0].rows[0][4]
    moved.tabs[0].rows[0].pop()
    h.sheets.save(moved)
    const before = await h.sheets.read(h.owner, b.id)
    spy.mockClear()
    await expect(h.writer.retry(h.owner, A.aid, '1')).rejects.toThrow(
      '重新確認',
    )
    expect(spy).not.toHaveBeenCalled()
    expect(await h.sheets.read(h.owner, b.id)).toEqual(before)
    const reviewed = await h.writer.preview(h.owner, A.aid, '1')
    await h.writer.confirm(h.owner, A.aid, '1', reviewed.key, ['C3'])
    expect(
      (await h.sheets.read(h.owner, b.id)).tabs[0].rows[2][2].userEnteredValue,
    ).toEqual({ stringValue: 'OLD' })
  } finally {
    h.db.close()
  }
})
it('插入說明列後重定位；同號換題、改號或刪題不應寫入', async () => {
  const h = setup()
  try {
    const { aid } = await h.settled(),
      b = sample()
    b.tabs[0].rows.splice(2, 0, [])
    h.sheets.save(b)
    const p = await h.writer.preview(h.owner, aid, '1')
    expect(p.slots.map((s) => s.address)).toEqual(['C4', 'D4'])
    const write = vi.spyOn(h.sheets, 'write')
    b.tabs[0].rows[3][1] = { userEnteredValue: { stringValue: '不同題目' } }
    h.sheets.save(b)
    await expect(
      h.writer.confirm(h.owner, aid, '1', p.key, []),
    ).rejects.toThrow()
    b.tabs[0].rows.splice(3, 1)
    h.sheets.save(b)
    await expect(h.writer.preview(h.owner, aid, '1')).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
  } finally {
    h.db.close()
  }
})

it('重複確認、不同場次無勝組及題目重新排序', async () => {
  const h = setup()
  try {
    const { aid } = await h.settled(),
      b = sample(),
      rows = b.tabs[0].rows
    ;[rows[2], rows[3]] = [rows[3], rows[2]]
    h.sheets.save(b)
    const p = await h.writer.preview(h.owner, aid, '1')
    expect(p.slots.map((t) => t.address)).toEqual(['C4', 'D4'])
    const writes = vi.spyOn(h.sheets, 'write')
    await Promise.all([
      h.writer.confirm(h.owner, aid, '1', p.key, []),
      h.writer.confirm(h.owner, aid, '1', p.key, []),
    ])
    expect(writes).toHaveBeenCalledTimes(1)
    expect(h.quiz.view(aid, { teacher: h.owner }).questions[0].progress).toBe(
      '已確認寫入',
    )
    const next = await h.activity()
    const prompt = h.quiz.control(h.owner, next, 'open')
    h.quiz.control(h.owner, next, 'open', prompt.confirmation)
    h.quiz.control(h.owner, next, 'close')
    const before = await h.sheets.read(h.owner, b.id)
    await expect(h.writer.preview(h.owner, next, '1')).rejects.toThrow('略過')
    expect(await h.sheets.read(h.owner, b.id)).toEqual(before)
  } finally {
    h.db.close()
  }
})

it('公式顯示與勝答相同仍須覆蓋同意，重新確認保留首次公布時間', async () => {
  const h = setup()
  try {
    const { aid } = await h.settled()
    const b = sample(),
      cell = b.tabs[0].rows[2][2]
    cell.userEnteredValue = { formulaValue: '="CPU"' }
    cell.formattedValue = 'CPU'
    cell.userEnteredFormat = {
      backgroundColor: { red: 1 },
      numberFormat: { type: 'TEXT' },
      borders: { bottom: { style: 'SOLID' } },
    }
    h.sheets.save(b)
    const p = await h.writer.preview(h.owner, aid, '1')
    await expect(
      h.writer.confirm(h.owner, aid, '1', p.key, []),
    ).rejects.toThrow('同意覆蓋 C3')
    const publication = () =>
      h.db.one("SELECT published_at FROM questions WHERE aid=? AND q='1'", aid)!
        .published_at
    expect(publication()).toBeNull()
    await h.writer.confirm(h.owner, aid, '1', p.key, ['C3'])
    const first = publication()
    expect(first).toBeGreaterThan(0)
    const after = (await h.sheets.read(h.owner, b.id)).tabs[0].rows[2][2]
    expect(after.userEnteredValue).toEqual({ stringValue: 'CPU' })
    expect(after.userEnteredFormat).toEqual(cell.userEnteredFormat)
    const again = await h.writer.preview(h.owner, aid, '1')
    await h.writer.confirm(h.owner, aid, '1', again.key, [])
    expect(publication()).toBe(first)
  } finally {
    h.db.close()
  }
})
