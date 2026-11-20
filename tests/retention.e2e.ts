import type { Page } from '@playwright/test'
import { test, expect } from './browser-fixture'
import { Retention } from '../server/retention'
import { url } from './support'

async function login(
  page: Page,
  origin: string,
  name: string,
  password: string,
) {
  await page.goto(origin + '/?role=teacher')
  await page.getByLabel('教師帳號').fill(name)
  await page.getByLabel('密碼').fill(password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的活動' })).toBeVisible()
}
const row = (page: Page, id: string) =>
  page.locator('[data-activity="' + id + '"]')
async function join(page: Page, origin: string, code: string, pin: string) {
  await page.goto(origin)
  await page.getByLabel('活動加入碼').fill(code)
  await page.getByRole('button', { name: '進入活動' }).click()
  await page.getByRole('button', { name: '加入既有組' }).click()
  await page.getByLabel('組內加入碼').fill(pin)
  await page.getByRole('button', { name: '加入組別', exact: true }).click()
}

test('同名單場取消、混合批次、他人權限與確認期間開場', async ({
  browser,
  env,
}) => {
  const t = await browser.newPage(),
    other = await browser.newPage()
  try {
    const prep = await env.activity(),
      race = await env.activity(),
      open = await env.activity(),
      failed = await env.settled(),
      done = await env.activity()
    env.member(race, '100000001')
    env.member(open, '100000002')
    env.quiz.control(env.owner, open, 'open')
    const prompt = env.quiz.control(env.owner, done, 'open')
    env.quiz.control(env.owner, done, 'open', prompt.confirmation)
    env.quiz.control(env.owner, done, 'close')
    env.db.run(
      "UPDATE questions SET progress='失敗' WHERE aid=? AND q='1'",
      failed.aid,
    )
    env.db.teacher('其他教師', env.password)
    await login(other, env.origin, '其他教師', env.password)
    await expect(other.locator('[data-activity]')).toHaveCount(0)
    const foreignStatus = await other.evaluate(async (id) => {
      const response = await fetch('/api/teacher/remove', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + localStorage.getItem('quiz-teacher'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'other',
          items: [{ id, version: 0 }],
        }),
      })
      return response.json()
    }, prep)
    expect(foreignStatus).toEqual([{ id: prep, message: '無法操作此活動' }])
    await login(t, env.origin, env.owner, env.password)
    let writes = 0
    t.on('request', (r) => {
      if (r.url().endsWith('/teacher/remove')) writes++
    })
    await row(t, prep)
      .getByRole('button', { name: '移除', exact: true })
      .click()
    const dialog = t.getByRole('dialog')
    await expect(dialog).toContainText(env.quiz.activity(prep).code)
    await expect(dialog).toContainText('學生將無法再進入，活動紀錄會保留')
    await dialog.getByRole('button', { name: '取消' }).click()
    expect(writes).toBe(0)
    const single = await env.activity()
    await row(t, single)
      .getByRole('button', { name: '移除', exact: true })
      .click()
    await expect(dialog).toContainText(env.quiz.activity(single).code)
    await dialog.getByRole('button', { name: '確認移除' }).click()
    await expect(row(t, single)).toHaveCount(0)
    await expect(row(t, prep)).toBeVisible()
    await t.getByRole('button', { name: '已移除清單' }).click()
    await expect(t.locator('[data-activity]')).toHaveCount(1)
    await expect(row(t, single)).toBeVisible()
    await t.getByRole('button', { name: '返回我的活動' }).click()
    for (const aid of [prep, race, open, failed.aid, done])
      await row(t, aid).getByRole('checkbox').check()
    await t.getByRole('button', { name: '移除勾選活動' }).click()
    await expect(dialog).toContainText('請先截止')
    await expect(dialog).toContainText('第 1 題 失敗')
    env.quiz.control(env.owner, race, 'open')
    await dialog.getByRole('button', { name: '確認移除' }).click()
    await expect(t.locator('[data-activity]')).toHaveCount(3)
    for (const aid of [race, open, failed.aid])
      await expect(row(t, aid)).toBeVisible()
    await t.getByRole('button', { name: '已移除清單' }).click()
    await expect(row(t, prep)).toBeVisible()
    await expect(row(t, done)).toBeVisible()
    expect(writes).toBe(2)
  } finally {
    await Promise.all([t.close(), other.close()])
  }
})

test('等待頁停止輪詢及忽略遲到成功回覆，準備中還原後教師分送兩組新碼', async ({
  browser,
  env,
}) => {
  const t = await browser.newPage(),
    a = await browser.newPage(),
    b = await browser.newPage()
  try {
    const aid = await env.activity(),
      code = env.quiz.activity(aid).code
    const first = env.member(aid, '100000001'),
      second = env.member(aid, '100000002')
    await login(t, env.origin, env.owner, env.password)
    await join(a, env.origin, code, first.group.joinCode!)
    await join(b, env.origin, code, second.group.joinCode!)
    await expect(a.getByText('等待教師開場')).toBeVisible()
    await expect(b.getByText('等待教師開場')).toBeVisible()
    const acquired = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let requests = 0
    await a.route('**/api/activities/' + aid, async (route) => {
      requests++
      if (requests === 1) {
        const response = await route.fetch()
        acquired.resolve()
        await release.promise
        await route.fulfill({ response })
      } else await route.continue()
    })
    await acquired.promise
    await row(t, aid).getByRole('button', { name: '移除', exact: true }).click()
    await t.getByRole('button', { name: '確認移除' }).click()
    await expect(row(t, aid)).toHaveCount(0)
    await a.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(a.getByLabel('活動加入碼')).toBeVisible()
    release.resolve()
    await expect(b.getByLabel('活動加入碼')).toBeVisible()
    const count = requests
    await a.waitForTimeout(1600)
    expect(requests).toBe(count)
    await expect(a.getByText('等待教師開場')).toHaveCount(0)
    await t.getByRole('button', { name: '已移除清單' }).click()
    await row(t, aid).getByRole('button', { name: '還原' }).click()
    await t.getByRole('button', { name: '確認還原' }).click()
    await expect(t.getByText(/新活動碼/)).toBeVisible()
    const renewed = env.quiz.activity(aid).code
    const pins = env.db.all(
      'SELECT label,joincode FROM groups_ WHERE aid=? ORDER BY label',
      aid,
    )
    for (const group of pins)
      await expect(
        t.getByText(group.label + ' · ' + group.joincode),
      ).toBeVisible()
    await a.getByLabel('活動加入碼').fill(code)
    await a.getByRole('button', { name: '進入活動' }).click()
    await expect(a.getByRole('alert')).toContainText('無效')
    await join(a, env.origin, renewed, first.group.joinCode!)
    await expect(a.getByRole('alert')).toContainText('無效')
    await a.getByLabel('組內加入碼').fill(pins[0].joincode)
    await a.getByRole('button', { name: '加入組別', exact: true }).click()
    await expect(a.getByText('G01', { exact: true })).toBeVisible()
    await join(b, env.origin, renewed, pins[1].joincode)
    await expect(b.getByText('G02', { exact: true })).toBeVisible()
    await expect(b.getByText(pins[0].joincode, { exact: true })).toHaveCount(0)
    await t.getByRole('button', { name: '返回我的活動' }).click()
    await row(t, aid).locator('button.activity').click()
    await t.getByRole('button', { name: '開放搶答', exact: true }).click()
    await expect(b.locator('[data-q="1"] textarea')).toBeEnabled({
      timeout: 2000,
    })
  } finally {
    await Promise.all([t.close(), a.close(), b.close()])
  }
})

test('已結束還原沿用原碼，兩組重新加入只取回各自收據與已公布結果', async ({
  browser,
  env,
}) => {
  const t = await browser.newPage(),
    a = await browser.newPage(),
    b = await browser.newPage()
  try {
    const aid = await env.activity(),
      code = env.quiz.activity(aid).code
    const x = env.member(aid, '100000001'),
      y = env.member(aid, '100000002')
    env.quiz.control(env.owner, aid, 'open')
    env.submit(y.session, aid, 'CPU')
    env.submit(x.session, aid, '甲組私人答案')
    env.quiz.control(env.owner, aid, 'close')
    const p = await env.writer.preview(env.owner, aid, '1')
    await env.writer.confirm(env.owner, aid, '1', p.key, [])
    await login(t, env.origin, env.owner, env.password)
    await join(a, env.origin, code, x.group.joinCode!)
    await join(b, env.origin, code, y.group.joinCode!)
    await expect(a.getByText('甲組私人答案', { exact: true })).toBeVisible()
    await row(t, aid).getByRole('button', { name: '移除', exact: true }).click()
    await t.getByRole('button', { name: '確認移除' }).click()
    await expect(a.getByLabel('活動加入碼')).toBeVisible()
    await expect(b.getByLabel('活動加入碼')).toBeVisible()
    await t.getByRole('button', { name: '已移除清單' }).click()
    await row(t, aid).getByRole('button', { name: '還原' }).click()
    await t.getByRole('button', { name: '確認還原' }).click()
    await expect(row(t, aid)).toHaveCount(0)
    await t.getByRole('button', { name: '返回我的活動' }).click()
    await row(t, aid).locator('button.activity').click()
    await expect(t.locator('tbody tr').first().locator('td')).toHaveText([
      'G02',
      '1',
      'CPU',
    ])
    await expect(t.getByText('已確認寫入', { exact: true })).toBeVisible()
    await t.getByText('查看組長名冊').click()
    await expect(t.locator('details')).toContainText('100000001')
    await expect(t.locator('details')).toContainText('100000002')
    await expect(t.getByRole('button', { name: '開放搶答' })).toHaveCount(0)
    await join(a, env.origin, code, x.group.joinCode!)
    await join(b, env.origin, code, y.group.joinCode!)
    await expect(a.getByText('甲組私人答案', { exact: true })).toBeVisible()
    await expect(b.getByText('公布勝答：CPU')).toBeVisible()
    await expect(b.getByText('甲組私人答案', { exact: true })).toHaveCount(0)
    await expect(a.getByRole('button', { name: '送出答案' })).toHaveCount(0)
    expect(env.db.all('SELECT rank FROM submissions ORDER BY rank')).toEqual([
      { rank: 1 },
      { rank: 2 },
    ])
  } finally {
    await Promise.all([t.close(), a.close(), b.close()])
  }
})

test('零組開場提示、取消、確認與提示期間建立第一組', async ({
  browser,
  env,
}) => {
  const t = await browser.newPage(),
    student = await browser.newPage()
  try {
    const aid = await env.activity(),
      second = await env.activity(),
      third = await env.activity()
    await login(t, env.origin, env.owner, env.password)
    await student.goto(env.origin)
    await student.getByLabel('活動加入碼').fill(env.quiz.activity(aid).code)
    await student.getByRole('button', { name: '進入活動' }).click()
    await row(t, aid).locator('button.activity').click()
    const open = t.getByRole('button', { name: '開放搶答', exact: true })
    await open.click()
    const prompt = t.getByRole('dialog')
    await expect(prompt).toContainText('目前尚無組別，仍要開放搶答嗎？')
    await prompt.getByRole('button', { name: '取消' }).click()
    expect(env.quiz.activity(aid).phase).toBe('準備中')
    await open.click()
    for (const invalid of [
      '023456789',
      '１２３４５６７８９',
      '1234 6789',
      '12345678a',
      '12345678',
      '1234567890',
    ]) {
      await student.getByLabel('組長學號').fill(invalid)
      await student.getByRole('button', { name: '建立組別' }).click()
      await expect(student.getByRole('alert')).toContainText('九位')
    }
    await student.getByLabel('組長學號').fill(' 123456789 ')
    await student.getByRole('button', { name: '建立組別' }).click()
    await expect(student.getByText('等待教師開場')).toBeVisible()
    await prompt.getByRole('button', { name: '確認開場' }).click()
    await expect(student.locator('[data-q="1"] textarea')).toBeEnabled({
      timeout: 2000,
    })
    await t.getByRole('button', { name: /我的活動/ }).click()
    await row(t, second).locator('button.activity').click()
    await open.click()
    await env.quiz.import(env.owner, second, url, 999).catch(() => {})
    await prompt.getByRole('button', { name: '確認開場' }).click()
    await expect(t.getByRole('alert')).toContainText('匯入')
    await t.getByRole('button', { name: /我的活動/ }).click()
    await row(t, third).locator('button.activity').click()
    await open.click()
    new Retention(env.db).change(env.owner, 'remove', 'race', [
      { id: third, version: 0 },
    ])
    await prompt.getByRole('button', { name: '確認開場' }).click()
    await expect(t.getByRole('alert')).toContainText('移除')
  } finally {
    await Promise.all([t.close(), student.close()])
  }
})

test('零組可直接確認開場，教師畫面仍為零而後端有組則單擊開場', async ({
  browser,
  env,
}) => {
  const t = await browser.newPage(),
    student = await browser.newPage(),
    late = await browser.newPage()
  try {
    const empty = await env.activity(),
      stale = await env.activity()
    await login(t, env.origin, env.owner, env.password)
    await row(t, empty).locator('button.activity').click()
    const open = t.getByRole('button', { name: '開放搶答', exact: true })
    await open.click()
    await t.getByRole('button', { name: '確認開場' }).click()
    await expect(t.getByRole('button', { name: '結束整場' })).toBeVisible()
    expect(env.quiz.activity(empty).phase).toBe('開放中')
    await t.getByRole('button', { name: /我的活動/ }).click()
    await row(t, stale).locator('button.activity').click()
    await expect(t.locator('.summary strong').nth(1)).toHaveText('0')
    await t.route('**/api/activities/' + stale, async (route) => {
      const res = await route.fetch()
      const snapshot = await res.json()
      await route.fulfill({ response: res, json: { ...snapshot, groups: [] } })
    })
    const group = env.member(stale, '123456789')
    await join(
      student,
      env.origin,
      env.quiz.activity(stale).code,
      group.group.joinCode!,
    )
    await expect(student.getByText('等待教師開場')).toBeVisible()
    const opened = t.waitForResponse((r) => r.url().endsWith('/open') && r.ok())
    await open.click()
    await opened
    const started = Date.now()
    await expect(student.locator('[data-q="1"] textarea')).toBeEnabled({
      timeout: 2000,
    })
    expect(Date.now() - started).toBeLessThanOrEqual(2000)
    await expect(t.getByRole('button', { name: '結束整場' })).toBeVisible()
    await expect(t.getByRole('dialog')).toHaveCount(0)
    await late.goto(env.origin)
    await late.getByLabel('活動加入碼').fill(env.quiz.activity(stale).code)
    await late.getByRole('button', { name: '進入活動' }).click()
    for (const value of [
      '',
      '023456789',
      '１２３４５６７８９',
      '1234 6789',
      '12345678a',
      '12345678',
      '1234567890',
    ]) {
      await late.getByLabel('組長學號').fill(value)
      await late.getByRole('button', { name: '建立組別' }).click()
      await expect(late.getByLabel('組長學號')).toBeVisible()
      expect(
        env.db.one('SELECT COUNT(*) AS n FROM groups_ WHERE aid=?', stale)?.n,
      ).toBe(1)
    }
    await late.getByLabel('組長學號').fill(' 100000003 ')
    await late.getByRole('button', { name: '建立組別' }).click()
    await expect(late.getByText('G02', { exact: true })).toBeVisible()
  } finally {
    await Promise.all([t.close(), student.close(), late.close()])
  }
})
