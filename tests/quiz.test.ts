import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup } from './support'
import { Store } from '../server/db'
import { Quiz } from '../server/quiz'
import { application } from '../server/app'
it('首筆資格、同組雙裝置、文字原樣、敗組收據與跨場隔離', async () => {
  const h = setup()
  try {
    const aid = await h.activity(),
      a = h.member(aid, '100000001'),
      b = h.member(aid, '100000002')
    expect(h.quiz.join(a.session, '100000001', undefined).label).toBe(
      a.group.label,
    )
    h.db.session(null, aid)
    const other = h.db.one(
      'SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1',
    )!
    h.quiz.join(other, undefined, a.group.joinCode)
    const second = h.db.one(
      'SELECT * FROM sessions WHERE token=?',
      other.token,
    )!
    h.quiz.control(h.owner, aid, 'open')
    const late = h.member(aid, '100000003')
    expect(late.group.label).toBe('組003')
    expect(h.quiz.view(aid, { teacher: h.owner }).groups).toHaveLength(3)
    expect(() => h.submit(a.session, aid, '　\t\r\n')).toThrow('空白')
    expect(() => h.submit(a.session, aid, 'X', '999')).toThrow('題號')
    expect(h.submit(a.session, aid, ' 001\r\n錯 ')).toEqual({
      answer: ' 001\n錯 ',
      status: '已收件',
    })
    expect(h.submit(second, aid, ' 001\n錯 ').status).toBe('先前已收件')
    expect(() => h.submit(second, aid, 'CPU')).toThrow('本組已提交')
    h.submit(b.session, aid, 'CPU')
    expect(h.quiz.view(aid, b.session).questions[0]).toEqual({
      q: '1',
      label: '1',
      ownAnswer: 'CPU',
    })
    h.quiz.control(h.owner, aid, 'close')
    h.quiz.control(h.owner, aid, 'close')
    expect(h.quiz.view(aid, b.session).questions[0].winner).toBe(a.group.label)
    expect(h.submit(a.session, aid, ' 001\n錯 ').status).toBe('先前已收件')
    expect(() => h.submit(second, aid, '新')).toThrow('已結束')
    expect(() => h.member(aid, '100000004')).toThrow('已結束')
    expect(() => h.quiz.control(h.owner, aid, 'open')).toThrow('已結束')
    const next = await h.activity()
    expect(() => h.submit(a.session, next, 'X')).toThrow('無權')
    expect(h.quiz.join(other, undefined, a.group.joinCode).label).toBe(
      a.group.label,
    )
  } finally {
    h.db.close()
  }
})
it('SQLite 檔案重啟、複合外鍵、唯一鍵、交易回滾', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-')),
    file = join(dir, 'data.sqlite'),
    h = setup(file)
  try {
    const { aid, a } = await h.settled()
    const seq = h.seq()
    expect(() =>
      h.db.run(
        'INSERT INTO submissions VALUES(?,?,?,?,?,?)',
        aid,
        '1',
        a.session.gid,
        'duplicate',
        seq,
        2,
      ),
    ).toThrow()
    expect(() =>
      h.db.run(
        'INSERT INTO submissions VALUES(?,?,?,?,?,?)',
        aid,
        '1',
        'other',
        'foreign',
        seq,
        2,
      ),
    ).toThrow()
    const next = await h.activity(),
      n = h.member(next, '100000005')
    expect(() =>
      h.db.run(
        'INSERT INTO submissions VALUES(?,?,?,?,?,?)',
        aid,
        '1',
        n.session.gid,
        'other activity',
        seq,
        1,
      ),
    ).toThrow()
    expect(() =>
      h.db.tx(() => {
        h.db.run("UPDATE activities SET title='changed' WHERE id=?", aid)
        throw Error('rollback')
      }),
    ).toThrow()
    expect(h.quiz.activity(aid).title).toBe('課堂')
    const second = h.member(next, '100000006')
    h.quiz.control(h.owner, next, 'open')
    h.submit(n.session, next, 'test')
    expect(() =>
      h.db.run(
        'INSERT INTO submissions VALUES(?,?,?,?,?,?)',
        next,
        '1',
        second.session.gid,
        'tied',
        seq,
        1,
      ),
    ).toThrow(/UNIQUE/)
    h.db.close()
    const reopened = new Store(file)
    try {
      const v = new Quiz(reopened, h.sheets).view(aid, a.session)
      expect(v.phase).toBe('已結束')
      expect(v.questions[0]).toMatchObject({
        winner: a.group.label,
        ownAnswer: 'CPU',
      })
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it('教師權限、失效密碼與校驗前版顯式重選', async () => {
  const h = setup()
  const app = application({ db: h.db, sheets: h.sheets })
  try {
    const aid = await h.activity(),
      a = h.member(aid, '100000001')
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { name: h.owner, password: 'wrong' },
        })
      ).statusCode,
    ).toBe(401)
    const auth = (token: string) => ({ authorization: 'Bearer ' + token })
    const post = (path: string, token: string, payload = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/activities/' + aid + '/' + path,
        headers: auth(token),
        payload,
      })
    expect((await post('open', a.token)).statusCode).toBe(403)
    expect((await post('questions/1/preview', a.token)).statusCode).toBe(403)
    const t = h.db.login(h.owner, h.password)
    await post('import', t, {
      url: 'https://docs.google.com/spreadsheets/d/classroom-fixture-v1/edit',
      tab: 999,
    })
    expect((await post('open', t)).statusCode).toBe(409)
    expect(
      (
        await post('reselect', t, {
          book: 'classroom-fixture-v1',
          tab: 1,
          count: 6,
        })
      ).statusCode,
    ).toBe(200)
    expect((await post('open', t)).statusCode).toBe(200)
    expect((await post('import', t, { url: 'x', tab: 1 })).statusCode).toBe(409)
  } finally {
    await app.close()
    h.db.close()
  }
})

it('建組重送與偽填身分不增加組數，晚到者可加入既有組', async () => {
  const h = setup(),
    app = application({ db: h.db, sheets: h.sheets })
  try {
    const aid = await h.activity()
    const enter = async (code: string) =>
      app.inject({ method: 'POST', url: '/api/enter', payload: { code } })
    expect((await enter('bad')).statusCode).toBe(404)
    const { token } = (await enter(h.quiz.activity(aid).code)).json()
    function post(
      key: string,
      action: string,
      payload: Record<string, string>,
    ) {
      return app.inject({
        method: 'POST',
        url: '/api/activities/' + aid + '/' + action,
        headers: { authorization: 'Bearer ' + key },
        payload,
      })
    }
    const [one, two] = await Promise.all([
      post(token, 'group', { leader: '100000101', name: '重送組' }),
      post(token, 'group', { leader: '100000101', name: '重送組' }),
    ])
    expect(one.json()).toEqual(two.json())
    expect(one.json().label).toBe('重送組')
    const b = h.member(aid, '100000102')
    expect(b.group.label).toBe('組102')
    h.quiz.control(h.owner, aid, 'open')
    const c = h.member(aid, '100000103')
    expect(c.group.label).toBe('組103')
    const late = h.db.session(null, aid)
    expect(
      (await post(late, 'group', { joinCode: 'invalid' })).statusCode,
    ).toBe(403)
    expect(
      (await post(late, 'group', { joinCode: c.group.joinCode! })).json(),
    ).toEqual({ label: '組103' })
    expect(
      (
        await post(late, 'questions/1/submit', {
          answer: 'x',
          gid: b.session.gid,
        })
      ).statusCode,
    ).toBe(403)
    expect(h.quiz.view(aid, { teacher: h.owner }).groups).toHaveLength(3)
    expect(h.db.all('SELECT * FROM submissions')).toHaveLength(0)
  } finally {
    await app.close()
    h.db.close()
  }
})

it('組名修整、唯一性與不耗用公開代號', async () => {
  const h = setup(), app = application({ db: h.db, sheets: h.sheets })
  try {
    const aid = await h.activity(), fresh = () => h.db.session(null, aid)
    const post = (token: string, payload: object) => app.inject({
      method: 'POST', url: '/api/activities/' + aid + '/group',
      headers: { authorization: 'Bearer ' + token }, payload,
    })
    expect((await post(fresh(), { leader: '100000201', name: '  第一組  ' })).json()).toMatchObject({ label: '第一組' })
    for (const name of ['第一組', ' ', 'a'.repeat(21), '有\n換行', '含\u0001控制'])
      expect((await post(fresh(), { leader: '100000202', name })).statusCode).toBeGreaterThanOrEqual(400)
    expect((await post(fresh(), { leader: '100000202', name: '第二組' })).json()).toMatchObject({ label: '第二組' })
    expect(h.db.all('SELECT label,name FROM groups_ WHERE aid=? ORDER BY label', aid)).toEqual([
      { label: 'G01', name: '第一組' }, { label: 'G02', name: '第二組' },
    ])
  } finally { await app.close(); h.db.close() }
})

it('場次所有權、結束場恢復原收據及舊頁不得寫入新場', async () => {
  const h = setup(),
    app = application({ db: h.db, sheets: h.sheets })
  try {
    const { aid, a } = await h.settled()
    h.db.teacher('另一教師', h.password)
    const unrelated = h.db.login('另一教師', h.password)
    const api = (
      method: 'GET' | 'POST',
      path: string,
      token: string,
      data?: Record<string, string>,
    ) =>
      app.inject({
        method,
        url: path,
        headers: { authorization: 'Bearer ' + token },
        payload: data,
      })
    const base = '/api/activities/' + aid
    expect((await api('GET', base, unrelated)).statusCode).toBe(403)
    expect((await api('POST', base + '/close', unrelated, {})).statusCode).toBe(
      403,
    )
    expect(
      (await api('POST', base + '/questions/1/preview', unrelated, {}))
        .statusCode,
    ).toBe(403)
    const recovered = h.db.session(null, aid)
    expect(
      (
        await api('POST', base + '/group', recovered, {
          joinCode: a.group.joinCode!,
        })
      ).json(),
    ).toEqual({ label: '組001' })
    expect(
      (await api('GET', base + '/questions/1/receipt', recovered)).json(),
    ).toEqual({ answer: 'CPU' })
    expect((await api('GET', base, recovered)).json().questions[0]).toEqual({
      q: '1',
      label: '1',
      ownAnswer: 'CPU',
      winner: '組001',
    })
    const fresh = await h.activity()
    const prompt = h.quiz.control(h.owner, fresh, 'open')
    h.quiz.control(h.owner, fresh, 'open', prompt.confirmation)
    expect(
      (
        await api('POST', base + '/questions/2/submit', recovered, {
          answer: '晚到',
        })
      ).json().error,
    ).toBe('活動已結束')
    expect(
      (
        await api(
          'POST',
          '/api/activities/' + fresh + '/questions/1/submit',
          recovered,
          { answer: '錯場' },
        )
      ).statusCode,
    ).toBe(403)
    expect(h.db.all('SELECT aid FROM submissions')).toEqual([{ aid }])
    expect(h.quiz.view(aid, { teacher: h.owner }).groups).toHaveLength(1)
  } finally {
    await app.close()
    h.db.close()
  }
})
