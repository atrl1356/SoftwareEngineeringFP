import type { Page } from '@playwright/test'
import { test, expect } from './browser-fixture'
import { performance } from 'node:perf_hooks'
import { sample } from './support'
test('第 37 題：三個獨立工作階段、同步延遲與雙格回寫', async ({
  browser,
  env,
}) => {
  const [tc, ac, bc] = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ])
  const t = await tc.newPage(),
    a = await ac.newPage(),
    b = await bc.newPage()
  const base = env.origin,
    creds = { name: env.owner, password: env.password },
    db = env.db
  try {
    await t.goto(base + '/?role=teacher')
    await t.getByLabel('教師帳號').fill(creds.name)
    await t.getByLabel('密碼').fill(creds.password)
    await t.getByRole('button', { name: '登入', exact: true }).click()
    await t.getByLabel('活動名稱').fill('課堂驗收')
    await t.getByRole('button', { name: '建立活動' }).click()
    const code = await t.locator('.summary strong').first().textContent()
    await t.getByRole('button', { name: '讀取分頁' }).click()
    await t.getByRole('combobox').selectOption('1')
    await t.getByRole('button', { name: '匯入題目' }).click()
    await expect(t.getByText('已匯入', { exact: false })).toContainText('6 題')
    async function join(p: Page, leader: string) {
      await p.goto(base)
      await p.getByLabel('活動加入碼').fill(code!)
      await p.getByRole('button', { name: '進入活動' }).click()
      await p.getByLabel('組長學號').fill(leader)
      await p.getByLabel('組別名稱').fill('組' + leader.slice(-3))
      await p.getByRole('button', { name: '建立組別' }).click()
      await expect(p.getByText('等待教師開場')).toBeVisible()
    }
    await join(a, '100000001')
    await join(b, '100000002')
    const aq = a.locator('[data-q="1"]'),
      bq = b.locator('[data-q="1"]')
    async function timing(
      action: string,
      label: string,
      visible: () => Promise<void>,
    ) {
      const success = t
        .waitForResponse(
          (r) =>
            r.url().endsWith('/' + action) &&
            r.request().method() === 'POST' &&
            r.ok(),
        )
        .then(() => performance.now())
      await t.getByRole('button', { name: label }).click()
      const start = await success
      await visible()
      const elapsed = Math.round(performance.now() - start)
      console.log('階段同步 ' + action + ' ' + elapsed + 'ms')
      expect(elapsed).toBeLessThanOrEqual(2000)
    }
    await timing('open', '開放搶答', () =>
      Promise.all([
        aq.getByRole('textbox').waitFor(),
        bq.getByRole('textbox').waitFor(),
      ]).then(() => {}),
    )
    async function submit(p: Page, text: string) {
      const q = p.locator('[data-q="1"]')
      await q.getByRole('textbox').fill(text)
      const result = p.waitForResponse((r) => r.url().endsWith('/1/submit'))
      await q.getByRole('button', { name: '送出答案' }).click()
      return (await result).json()
    }
    expect((await submit(a, '　')).error).toContain('空白')
    expect((await submit(b, 'CPU')).status).toBe('已收件')
    await expect(aq.getByRole('textbox')).toBeEnabled()
    expect((await submit(a, '中央處理器')).status).toBe('已收件')
    // 首次已鎖定 UI；模擬同裝置因回應遺失而在其瀏覽器工作階段重傳。
    const receipt = await b.evaluate(async () => {
      const aid = localStorage.getItem('quiz-activity'),
        token = localStorage.getItem(
          'quiz-student:' + localStorage.getItem('quiz-activity'),
        )
      const r = await fetch('/api/activities/' + aid + '/questions/1/submit', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ answer: 'CPU' }),
      })
      return r.json()
    })
    expect(receipt).toEqual({ status: '先前已收件', answer: 'CPU' })
    const snapshot = () =>
      a.evaluate(async () =>
        (
          await fetch(
            '/api/activities/' + localStorage.getItem('quiz-activity'),
            {
              headers: {
                authorization:
                  'Bearer ' +
                  localStorage.getItem(
                    'quiz-student:' + localStorage.getItem('quiz-activity'),
                  ),
              },
            },
          )
        ).json(),
      )
    const open = await snapshot()
    expect(open.questions[0]).toEqual({
      q: '1',
      label: '1',
      ownAnswer: '中央處理器',
    })
    await expect(t.locator('tbody tr').first()).toContainText('組002')
    await expect(t.locator('tbody tr').first()).toContainText('CPU')
    expect(db.all('SELECT rank,answer FROM submissions ORDER BY rank')).toEqual(
      [
        { rank: 1, answer: 'CPU' },
        { rank: 2, answer: '中央處理器' },
      ],
    )
    await timing('close', '結束整場', () =>
      Promise.all([
        aq.getByText('組002', { exact: true }).waitFor(),
        bq.getByText('組002', { exact: true }).waitFor(),
      ]).then(() => {}),
    )
    const closed = await snapshot()
    expect(closed.questions[0].winner).toBe('組002')
    expect(closed.questions[0]).not.toHaveProperty('winningAnswer')
    await t.getByRole('button', { name: '預覽兩格' }).click()
    await expect(t.getByText('作答 · C3')).toBeVisible()
    expect(db.one('SELECT snapshot FROM fixture_books')).toBeUndefined()
    await t.getByRole('button', { name: '確認回寫' }).click()
    await expect(aq.getByText('公布勝答：CPU')).toBeVisible()
    await expect(t.getByText('已確認寫入', { exact: true })).toBeVisible()
    const expected = sample()
    for (const [col, txt] of [
      [2, 'CPU'],
      [3, '組002'],
    ] as const) {
      const cell = expected.tabs[0].rows[2][col]
      cell.userEnteredValue = { stringValue: txt }
      cell.formattedValue = txt
    }
    expect(
      JSON.parse(db.one('SELECT snapshot FROM fixture_books')!.snapshot),
    ).toEqual(expected)
    expect((await snapshot()).questions[1]).not.toHaveProperty('winningAnswer')
  } finally {
    await Promise.all([tc.close(), ac.close(), bc.close()])
  }
})

for (const scenario of ['過期預覽', 'Google 拒寫'] as const) {
  test(
    scenario + '的逐題公布、教師狀態與雙格原值',
    async ({ env, browser }) => {
      const aid = await env.activity(),
        a = env.member(aid, '100000001'),
        b = env.member(aid, '100000002')
      env.quiz.control(env.owner, aid, 'open')
      env.submit(a.session, aid, 'CPU', '1')
      env.submit(b.session, aid, '另一未公布勝答', '2')
      env.quiz.control(env.owner, aid, 'close')
      const tc = await browser.newContext(),
        sc = await browser.newContext()
      try {
        await tc.addInitScript(
          (token) => localStorage.setItem('quiz-teacher', token),
          env.db.login(env.owner, env.password),
        )
        await sc.addInitScript(
          (v) => {
            localStorage.setItem('quiz-activity', v.aid)
            localStorage.setItem('quiz-student:' + v.aid, v.token)
          },
          { aid, token: a.token },
        )
        const t = await tc.newPage(),
          s = await sc.newPage()
        await t.goto(env.origin + '/?role=teacher')
        await t.locator('.activity').first().click()
        await s.goto(env.origin)
        await expect(s.getByText('組001', { exact: true }).first()).toBeVisible()
        await t.getByRole('button', { name: '預覽兩格' }).click()
        await expect(t.getByText('作答 · C3')).toBeVisible()
        const expected = sample()
        if (scenario === '過期預覽') {
          expected.tabs[0].rows[2][3].userEnteredValue = {
            stringValue: '人工修改',
          }
          env.sheets.save(expected)
        } else env.failNextWrite()
        await t.getByRole('button', { name: '確認回寫' }).click()
        await expect(t.getByRole('alert')).toContainText(
          scenario === '過期預覽' ? '過期' : '拒絕',
        )
        await expect(t.locator('.workspace .chip')).toHaveText(
          scenario === '過期預覽' ? '需確認衝突' : '失敗',
        )
        const q = s.locator('[data-q="1"]')
        if (scenario === 'Google 拒寫')
          await expect(q.getByText('公布勝答：CPU')).toBeVisible()
        else {
          await expect(t.locator('.slot').last()).toContainText('人工修改')
          await expect(t.getByRole('checkbox')).not.toBeChecked()
          await s.reload()
          await expect(q.getByText('組001', { exact: true })).toBeVisible()
          await expect(q.getByText('公布勝答：CPU')).toHaveCount(0)
        }
        await expect(
          s.locator('[data-q="2"]').getByText('組002', { exact: true }),
        ).toBeVisible()
        await expect(
          s.getByText('另一未公布勝答', { exact: false }),
        ).toHaveCount(0)
        expect(env.quiz.view(aid, a.session).questions[1]).not.toHaveProperty(
          'winningAnswer',
        )
        expect(await env.sheets.read(env.owner, expected.id)).toEqual(expected)
      } finally {
        await sc.close()
        await tc.close()
      }
    },
  )
}
for (const mode of ['open', 'close'] as const) {
  test('獨立階段延遲：' + mode, async ({ env, page, request }) => {
    const aid = await env.activity(),
      a = env.member(aid, '100000001'),
      teacher = env.db.login(env.owner, env.password)
    if (mode === 'close') env.quiz.control(env.owner, aid, 'open')
    await page.addInitScript(
      (v) => {
        localStorage.setItem('quiz-activity', v.aid)
        localStorage.setItem('quiz-student:' + v.aid, v.token)
      },
      { aid, token: a.token },
    )
    await page.goto(env.origin)
    const q = page.locator('[data-q="1"]')
    if (mode === 'open')
      await expect(page.getByText('等待教師開場')).toBeVisible()
    else await expect(q.getByRole('textbox')).toBeEnabled()
    const response = await request.post(
      env.origin + '/api/activities/' + aid + '/' + mode,
      { headers: { authorization: 'Bearer ' + teacher }, data: {} },
    )
    const start = performance.now()
    expect(response.ok()).toBe(true)
    if (mode === 'open') await q.getByRole('textbox').waitFor()
    else await q.getByText('無有效作答／無勝組').waitFor()
    const elapsed = Math.round(performance.now() - start)
    console.log('獨立量測 ' + mode + ' ' + elapsed + 'ms')
    expect(elapsed).toBeLessThanOrEqual(2000)
  })
}

test('重連先停用輸入，過時快照不得覆蓋截止狀態，送別題保留草稿', async ({
  env,
  page,
}) => {
  const aid = await env.activity(),
    member = env.member(aid, '100000001')
  env.quiz.control(env.owner, aid, 'open')
  await page.addInitScript(
    (v) => {
      localStorage.setItem('quiz-activity', v.aid)
      localStorage.setItem('quiz-student:' + v.aid, v.token)
    },
    { aid, token: member.token },
  )
  await page.goto(env.origin)
  const q1 = page.locator('[data-q="1"]'),
    q2 = page.locator('[data-q="2"]')
  await q1.getByRole('textbox').fill('草稿一')
  await q2.getByRole('textbox').fill('第二題')
  await q2.getByRole('button', { name: '送出答案' }).click()
  await expect(q2.getByText('已收件')).toBeVisible()
  await expect(q1.getByRole('textbox')).toHaveValue('草稿一')
  let captured!: () => void, release!: () => void, delivered!: () => void
  const intercepted = new Promise<void>((r) => (captured = r)),
    hold = new Promise<void>((r) => (release = r)),
    oldDelivered = new Promise<void>((r) => (delivered = r))
  let first = true
  await page.route('**/api/activities/' + aid, async (route) => {
    if (!first) {
      await route.continue()
      return
    }
    first = false
    const earlier = await route.fetch()
    captured()
    await hold
    await route.fulfill({ response: earlier })
    delivered()
  })
  await intercepted
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect(q1.getByRole('textbox')).toBeDisabled()
    env.quiz.control(env.owner, aid, 'close')
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(q1.getByText('無有效作答／無勝組')).toBeVisible()
  } finally {
    release()
  }
  await oldDelivered
  await expect(q1.getByRole('textbox')).toHaveCount(0)
  await page.reload()
  await expect(q2.getByText('第二題', { exact: true })).toBeVisible()
})
