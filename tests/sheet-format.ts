import assert from 'node:assert/strict'

type RgbColor = { red?: number; green?: number; blue?: number; alpha?: number }
type CellFormat = Record<string, unknown> & {
  backgroundColor?: RgbColor
  backgroundColorStyle?: { rgbColor?: RgbColor }
}

// Sheets 回傳 8 位元色階的分量。容許半個色階及回傳小數的捨入誤差。
const rgbTolerance = 0.5 / 255 + 1e-7

export function assertSeededCellFormat(
  actual: unknown,
  expected: unknown,
  location: string,
) {
  const { backgroundColor: expectedColor, ...expectedFormat } =
    expected as CellFormat
  assert.partialDeepStrictEqual(actual, expectedFormat, location + ' 格式不符')
  if (!expectedColor) return

  const format = actual as CellFormat
  const actualColor = format.backgroundColorStyle
    ? format.backgroundColorStyle.rgbColor
    : format.backgroundColor
  assert(actualColor, location + ' 缺少預期的 RGB 底色')
  assert.equal(
    actualColor.alpha ?? 1,
    expectedColor.alpha ?? 1,
    location + ' 底色透明度不符',
  )

  for (const channel of ['red', 'green', 'blue'] as const) {
    const before = expectedColor[channel] ?? 0
    const after = actualColor[channel] ?? 0
    assert(
      Number.isFinite(after) && Math.abs(after - before) <= rgbTolerance,
      `${location} 底色 ${channel} 預期 ${before}，讀回 ${after}`,
    )
  }
}
