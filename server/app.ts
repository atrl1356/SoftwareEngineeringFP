import Fastify, { type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Store, check, Problem, digest } from './db'
import { FixtureSheets, bookId, type Sheets } from './sheets'
import { GoogleSheets } from './google'
import { Quiz } from './quiz'
import { Retention } from './retention'
import type { ActivitySelection } from '../shared/types'
import { Writeback } from './writeback'

type Payload = Record<string, unknown>
function body(req: FastifyRequest): Payload {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Payload
}
function str(req: FastifyRequest, k: string) {
  const v = body(req)[k]
  check(typeof v === 'string', '缺少欄位 ' + k)
  return v
}
function param(req: FastifyRequest, k: string) {
  return (req.params as Record<string, string>)[k]
}
export interface Options {
  db: Store
  sheets?: Sheets
  now?: () => number
  sweepIntervalMs?: number
  onComplete?: (req: FastifyRequest) => void
  beforeValidation?: (req: FastifyRequest) => Promise<void>
}
export function application(opts: Options) {
  const app = Fastify({ bodyLimit: 256 * 1024 })
  const db = opts.db
  const retention = new Retention(db, opts.now)
  const google = new GoogleSheets(db)
  const sheets =
    opts.sheets ??
    (process.env.QUIZ_SHEETS === 'fixture'
      ? new FixtureSheets(
          db,
          JSON.parse(
            readFileSync(
              new URL('../fixtures/guided-notes-v1.json', import.meta.url),
              'utf8',
            ),
          ),
        )
      : google)
  const quiz = new Quiz(db, sheets),
    writer = new Writeback(db, sheets)
  function session(r: FastifyRequest) {
    const hdr = r.headers.authorization ?? ''
    const s = db.one(
      'SELECT * FROM sessions WHERE token=? AND expires>?',
      digest(hdr.startsWith('Bearer ') ? hdr.slice(7) : ''),
      Date.now(),
    )
    check(s, '請重新登入或加入活動', 401)
    return s
  }
  function teacher(r: FastifyRequest) {
    const s = session(r)
    check(s.teacher, '教師權限不足', 403)
    return String(s.teacher)
  }
  function activityTeacher(r: FastifyRequest) {
    const owner = teacher(r)
    const activity = quiz.owned(owner, param(r, 'aid'))
    // 第一輪頁面沒有版本欄位，僅能操作從未移除過的場次。
    check(
      (body(r).version ?? 0) === activity.version,
      '活動版本已變更，請重新載入',
      409,
    )
    return owner
  }
  // 登記收完整本文的時點。解析器仍由 Fastify 持有，授權及 handler 不負責取號。
  type Ticket = {
    prior: Promise<void>
    release: () => void
    running: boolean
    seq: number
  }
  let tail = Promise.resolve()
  const tickets = new WeakMap<FastifyRequest, Ticket>()
  app.addHook('onRequest', (r, reply, next) => {
    if ((r.routeOptions.config as { ordered?: boolean }).ordered) {
      let finished = false
      const reserve = () => {
        if (finished) return
        let release!: () => void
        const done = new Promise<void>((resolve) => {
          release = resolve
        })
        const seq = Number(
          db.run('INSERT INTO inbox DEFAULT VALUES').lastInsertRowid,
        )
        tickets.set(r, { prior: tail, release, running: false, seq })
        tail = Promise.all([tail, done]).then(() => {})
        opts.onComplete?.(r)
      }
      reply.raw.once('close', () => {
        finished = true
        const t = tickets.get(r)
        if (t && !t.running) {
          tickets.delete(r)
          t.release()
        }
      })
      if (
        !r.headers['transfer-encoding'] &&
        Number(r.headers['content-length'] ?? 0) === 0
      )
        reserve()
      else r.raw.prependOnceListener('end', reserve)
    }
    next()
  })
  app.addHook('onResponse', (r, _reply, next) => {
    tickets.get(r)?.release()
    next()
  })
  function ordered(fn: (r: FastifyRequest, seq: number) => unknown) {
    return async (r: FastifyRequest) => {
      const t = tickets.get(r)
      check(t, '請求本文未完整接收')
      t.running = true
      try {
        // 驗證可以不同步完成，階段讀取與狀態更動必須等到本命令的順位。
        await opts.beforeValidation?.(r)
        await t.prior
        return await fn(r, t.seq)
      } finally {
        t.release()
      }
    }
  }
  app.setErrorHandler((err: Error & { statusCode?: number }, _r, reply) => {
    const code = err.statusCode ?? 500
    reply.code(code).send({
      error:
        err instanceof Problem
          ? err.message
          : code >= 500
            ? '服務暫時無法完成操作'
            : '請求格式有誤',
      ...(err instanceof Problem && err.preview
        ? { preview: err.preview }
        : {}),
    })
  })
  app.addHook('preValidation', async (r) => {
    if (!r.url.startsWith('/api/activities/')) return
    const input = body(r),
      query = r.query as Record<string, unknown>
    // 場次取自路徑，組別取自工作階段；拒絕另外指定的身分，以免誤記他組。
    for (const field of [
      'aid',
      'gid',
      'groupId',
      'activityId',
      'teacher',
      'owner',
    ]) {
      check(!(field in input) && !(field in query), '不能改指定活動或組別', 403)
    }
  })
  app.get('/api/health', async () => ({ ok: true }))
  app.post('/api/login', async (r) => ({
    token: db.login(str(r, 'name'), str(r, 'password')),
  }))
  app.post('/api/logout', async (r) => {
    db.run('DELETE FROM sessions WHERE token=?', session(r).token)
    return { ok: true }
  })
  app.get('/api/teacher', async (r) => {
    const owner = teacher(r)
    return {
      owner,
      mode: sheets === google ? 'google' : 'fixture',
      connected: !!db.one('SELECT google FROM teachers WHERE name=?', owner)
        ?.google,
      activities: retention.list(owner, false),
      removed: retention.list(owner, true),
    }
  })
  for (const kind of ['remove', 'restore'] as const) {
    app.post('/api/teacher/' + kind, async (r) =>
      retention.change(
        teacher(r),
        kind,
        str(r, 'operation'),
        body(r).items as ActivitySelection[],
      ),
    )
  }
  app.post('/api/activities', async (r) => ({
    id: quiz.create(teacher(r), str(r, 'title')),
  }))
  app.post('/api/enter', async (r) => {
    const a = db.one(
      'SELECT id FROM activities WHERE code=? AND removed_at IS NULL',
      str(r, 'code'),
    )
    check(a, '活動加入碼無效', 404)
    return { aid: a.id, token: db.session(null, a.id) }
  })
  app.post('/api/activities/:aid/group', async (r) => {
    const s = session(r)
    check(s.aid === param(r, 'aid'), '活動身分不符', 403)
    return quiz.join(
      s,
      typeof body(r).leader === 'string' ? str(r, 'leader') : undefined,
      typeof body(r).joinCode === 'string' ? str(r, 'joinCode') : undefined,
    )
  })
  app.get('/api/activities/:aid', async (r) =>
    quiz.view(param(r, 'aid'), session(r)),
  )
  app.post('/api/books', async (r) => {
    const b = await sheets.read(teacher(r), bookId(str(r, 'url')))
    return {
      title: b.title,
      tabs: b.tabs.map((t) => ({ id: t.id, title: t.title })),
    }
  })
  app.post('/api/activities/:aid/import', async (r) => {
    const tab = body(r).tab
    check(
      typeof tab === 'number' && Number.isSafeInteger(tab),
      '請明確選擇分頁',
    )
    await quiz.import(activityTeacher(r), param(r, 'aid'), str(r, 'url'), tab)
    return { ok: true }
  })
  app.post('/api/activities/:aid/reselect', async (r) => {
    await quiz.reselect(
      activityTeacher(r),
      param(r, 'aid'),
      str(r, 'book'),
      Number(body(r).tab),
      Number(body(r).count),
    )
    return { ok: true }
  })
  const ordering = { config: { ordered: true } }
  for (const action of ['open', 'close'] as const)
    app.post(
      '/api/activities/:aid/' + action,
      ordering,
      ordered((r) =>
        quiz.control(
          activityTeacher(r),
          param(r, 'aid'),
          action,
          body(r).confirmation,
        ),
      ),
    )
  app.post(
    '/api/activities/:aid/questions/:q/submit',
    ordering,
    ordered((r, seq) =>
      quiz.submit(
        session(r),
        param(r, 'aid'),
        param(r, 'q'),
        str(r, 'answer'),
        seq,
      ),
    ),
  )
  const endpoint = '/api/activities/:aid/questions/:q/'
  app.get(endpoint + 'receipt', async (r) => {
    const s = session(r)
    check(s.gid && s.aid === param(r, 'aid'), '無權查詢', 403)
    quiz.activity(s.aid)
    return (
      db.one(
        'SELECT answer FROM submissions WHERE aid=? AND q=? AND gid=?',
        s.aid,
        param(r, 'q'),
        s.gid,
      ) ?? { answer: null }
    )
  })
  app.post(endpoint + 'preview', async (r) =>
    writer.preview(activityTeacher(r), param(r, 'aid'), param(r, 'q')),
  )
  app.post(endpoint + 'confirm', async (r) =>
    writer.confirm(
      activityTeacher(r),
      param(r, 'aid'),
      param(r, 'q'),
      str(r, 'key'),
      Array.isArray(body(r).approved) ? (body(r).approved as string[]) : [],
    ),
  )
  app.post(endpoint + 'retry', async (r) =>
    writer.retry(activityTeacher(r), param(r, 'aid'), param(r, 'q')),
  )
  app.post('/api/google/authorize', async (r, reply) => {
    const { state, url } = google.authorize(teacher(r))
    reply.header(
      'Set-Cookie',
      'quiz_oauth=' +
        state +
        '; HttpOnly; SameSite=Lax; Path=/api/google/callback; Max-Age=600' +
        (process.env.GOOGLE_REDIRECT_URI?.startsWith('https:')
          ? '; Secure'
          : ''),
    )
    return { url }
  })
  app.get('/api/google/callback', async (r, reply) => {
    const { state, code } = r.query as Record<string, string>
    check(
      state &&
        code &&
        r.headers.cookie?.split('; ').includes('quiz_oauth=' + state),
      'Google 授權確認失敗',
    )
    await google.callback(state, code)
    return reply.redirect('/?role=teacher')
  })
  if (existsSync(resolve('dist/index.html')))
    app.register(fastifyStatic, { root: resolve('dist') })
  const sweep = () => retention.sweep((error) => app.log.error(error))
  let cleanup: ReturnType<typeof setInterval>
  app.addHook('onReady', async () => {
    sweep()
    await writer.recover()
    cleanup = setInterval(sweep, opts.sweepIntervalMs ?? 60_000)
    cleanup.unref()
  })
  app.addHook('onClose', async () => clearInterval(cleanup))
  return app
}
