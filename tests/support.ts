import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/guided-notes-v1.json', import.meta.url),
    'utf8',
  ),
) as Book
import { Store, type Row } from '../server/db'
import { Quiz } from '../server/quiz'
import { FixtureSheets, type Book } from '../server/sheets'
import { Writeback } from '../server/writeback'
export const sample = () => structuredClone(fixture) as Book
export const url =
  'https://docs.google.com/spreadsheets/d/' + fixture.id + '/edit'
export function setup(file = ':memory:') {
  const db = new Store(file),
    sheets = new FixtureSheets(db, sample()),
    quiz = new Quiz(db, sheets),
    writer = new Writeback(db, sheets)
  const owner = 'teacher',
    password = randomBytes(16).toString('hex')
  db.teacher(owner, password)
  function member(aid: string, leader: string) {
    const token = db.session(null, aid),
      s = db.one('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1')!
    const group = quiz.join(s, leader, undefined)
    return {
      token,
      session: db.one('SELECT * FROM sessions WHERE token=?', s.token)!,
      group,
    }
  }
  const seq = () =>
    Number(db.run('INSERT INTO inbox DEFAULT VALUES').lastInsertRowid)
  const submit = (s: Row, aid: string, answer: string, q = '1') =>
    quiz.submit(s, aid, q, answer, seq())
  async function activity() {
    const aid = quiz.create(owner, '課堂')
    await quiz.import(owner, aid, url, 1)
    return aid
  }
  async function settled(text = 'CPU') {
    const aid = await activity(),
      a = member(aid, '100000001')
    quiz.control(owner, aid, 'open')
    submit(a.session, aid, text)
    quiz.control(owner, aid, 'close')
    return { aid, a }
  }
  return {
    db,
    sheets,
    quiz,
    writer,
    owner,
    password,
    member,
    seq,
    submit,
    activity,
    settled,
  }
}
