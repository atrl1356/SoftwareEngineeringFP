import http from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { application } from '../server/app'
import { setup } from './support'
function gate() {
  let open!: () => void
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})
async function server(open: boolean) {
  const h = setup(),
    aid = await h.activity(),
    a = h.member(aid, 'A'),
    b = h.member(aid, 'B'),
    teacher = h.db.login(h.owner, h.password)
  if (open) h.quiz.control(h.owner, aid, 'open')
  const early = gate(),
    later = gate(),
    release = gate(),
    firstChunk = gate()
  const app = application({
    db: h.db,
    sheets: h.sheets,
    onComplete: (req) => {
      if (req.headers['x-step'] === 'early') early.open()
      if (req.headers['x-step'] === 'later') later.open()
    },
    beforeValidation: async (req) => {
      if (req.headers['x-step'] === 'early') await release.wait
    },
  })
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.headers['x-step'] === 'later')
      req.raw.once('data', () => firstChunk.open())
    done()
  })
  const origin = await app.listen({ port: 0, host: '127.0.0.1' })
  cleanup.push(async () => {
    release.open()
    await app.close()
    h.db.close()
  })
  function connection(
    cmd: string,
    token: string,
    step: string,
    bodyless = false,
  ) {
    const value = JSON.stringify(cmd === 'submit' ? { answer: step } : {})
    const path =
      '/api/activities/' +
      aid +
      '/' +
      (cmd === 'submit' ? 'questions/1/submit' : cmd)
    const req = http.request(origin + path, {
      method: 'POST',
      agent: false,
      headers: {
        authorization: 'Bearer ' + token,
        'x-step': step,
        ...(bodyless
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(value),
            }),
      },
    })
    const result = new Promise<{ code: number; data: any }>(
      (resolve, reject) => {
        req.on('error', reject)
        req.on('response', (res) => {
          let buf = ''
          res.on('data', (c) => (buf += c))
          res.on('end', () =>
            resolve({ code: res.statusCode!, data: JSON.parse(buf) }),
          )
        })
      },
    )
    return {
      start: () => req.write(value.slice(0, 1)),
      end: () => req.end(value.slice(1)),
      all: () => req.end(bodyless ? undefined : value),
      result,
    }
  }
  return {
    ...h,
    aid,
    a,
    b,
    teacher,
    early,
    later,
    release,
    firstChunk,
    connection,
  }
}
it.each([
  ['submit', 'open', false, 0],
  ['open', 'submit', false, 1],
  ['close', 'submit', true, 0],
  ['submit', 'close', true, 1],
  ['submit', 'submit', true, 2],
] as const)(
  '完整請求 %s → %s，延後首筆驗證',
  async (first, second, opened, count) => {
    const s = await server(opened)
    const one = s.connection(
      first,
      first === 'submit' ? s.a.token : s.teacher,
      'early',
    )
    const two = s.connection(
      second,
      second === 'submit' ? s.b.token : s.teacher,
      'later',
    )
    // 第二條命令先送首段；等待伺服器實收後，第一條命令才傳完。
    two.start()
    await s.firstChunk.wait
    one.start()
    one.end()
    await s.early.wait
    two.end()
    await s.later.wait
    s.release.open()
    const [r1, r2] = await Promise.all([one.result, two.result])
    if (first === 'submit' && !opened) expect(r1.data.error).toBe('尚未開始')
    else expect(r1.code).toBe(200)
    if (first === 'close') expect(r2.data.error).toBe('活動已結束')
    else expect(r2.code).toBe(200)
    s.quiz.control(s.owner, s.aid, 'close')
    const row = s.quiz.view(s.aid, { teacher: s.owner }).questions[0]
    expect(row.submissions).toHaveLength(count)
    expect(row.submissions?.map((x) => x.rank)).toEqual(
      Array.from({ length: count }, (_, i) => i + 1),
    )
    expect(row.winner).toBe(
      count === 0
        ? null
        : first === 'submit'
          ? s.a.group.label
          : s.b.group.label,
    )
  },
)
it('無本文控制命令在請求結束時入列', async () => {
  const s = await server(false)
  const req = s.connection('open', s.teacher, 'normal', true)
  req.all()
  expect((await req.result).code).toBe(200)
})

it('同組兩台裝置由真實連線送不同答案，首次有效答案不被覆寫', async () => {
  const s = await server(true)
  const secondToken = s.db.session(null, s.aid)
  const member = s.db.one('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1')!
  s.quiz.join(member, undefined, s.a.group.joinCode)
  const first = s.connection('submit', s.a.token, 'early'),
    second = s.connection('submit', secondToken, 'later')
  first.all()
  await s.early.wait
  second.all()
  await s.later.wait
  s.release.open()
  expect((await first.result).data).toEqual({
    answer: 'early',
    status: '已收件',
  })
  expect((await second.result).data.error).toBe('本組已提交')
  const stored = s.db.all('SELECT rank,answer FROM submissions')
  expect(stored).toEqual([{ rank: 1, answer: 'early' }])
})
it('未安排到達次序的兩組並發仍只有第一位勝出', async () => {
  const s = await server(true),
    a = s.connection('submit', s.a.token, 'alpha'),
    b = s.connection('submit', s.b.token, 'beta')
  a.all()
  b.all()
  await Promise.all([a.result, b.result])
  s.quiz.control(s.owner, s.aid, 'close')
  const rows = s.db.all('SELECT gid,rank FROM submissions ORDER BY seq')
  expect(rows.map((r) => r.rank)).toEqual([1, 2])
  expect(
    s.db.one("SELECT winner FROM questions WHERE aid=? AND q='1'", s.aid)
      ?.winner,
  ).toBe(rows[0].gid)
})

it('開場前已送完整的答案拒收，開場後另一組才取得第一有效順位', async () => {
  const s = await server(false)
  const early = s.connection('submit', s.a.token, 'early'),
    opening = s.connection('open', s.teacher, 'later')
  early.all()
  await s.early.wait
  opening.all()
  await s.later.wait
  s.release.open()
  expect((await early.result).data.error).toBe('尚未開始')
  expect((await opening.result).code).toBe(200)
  const valid = s.connection('submit', s.b.token, 'after')
  valid.all()
  expect((await valid.result).code).toBe(200)
  s.quiz.control(s.owner, s.aid, 'close')
  expect(s.quiz.view(s.aid, { teacher: s.owner }).questions[0]).toMatchObject({
    winner: s.b.group.label,
    submissions: [{ rank: 1, label: s.b.group.label, answer: 'after' }],
  })
})
