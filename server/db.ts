import type { Preview } from '../shared/types'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto'

export class Problem extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly preview?: Preview,
  ) {
    super(message)
  }
}
export function check(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new Problem(message, status)
}
export const id = randomUUID
export const key = () => randomBytes(24).toString('base64url')
export const digest = (s: string) =>
  createHash('sha256').update(s).digest('hex')
export type Row = Record<string, any>
export class Store {
  sql: DatabaseSync
  constructor(file: string) {
    if (file !== ':memory:')
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.sql = new DatabaseSync(file)
    this.sql.exec(`
      PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS teachers(name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, google TEXT);
      CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES teachers(name), title TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL, phase TEXT NOT NULL DEFAULT '準備中', source TEXT, ready INTEGER NOT NULL DEFAULT 0, import_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS groups_(id TEXT PRIMARY KEY, aid TEXT NOT NULL REFERENCES activities(id), leader TEXT NOT NULL,
        label TEXT NOT NULL, joincode TEXT NOT NULL, UNIQUE(aid,id), UNIQUE(aid,leader), UNIQUE(aid,label), UNIQUE(aid,joincode));
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, teacher TEXT REFERENCES teachers(name), aid TEXT REFERENCES activities(id),
        gid TEXT, isleader INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, FOREIGN KEY(aid,gid) REFERENCES groups_(aid,id));
      CREATE TABLE IF NOT EXISTS questions(aid TEXT NOT NULL REFERENCES activities(id), q TEXT NOT NULL, label TEXT NOT NULL,
        stem TEXT NOT NULL, pos INTEGER NOT NULL, targets TEXT NOT NULL, winner TEXT, published INTEGER NOT NULL DEFAULT 0, published_at INTEGER,
        progress TEXT NOT NULL DEFAULT '待寫入', preview TEXT, consent TEXT, PRIMARY KEY(aid,q));
      CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS submissions(aid TEXT NOT NULL, q TEXT NOT NULL, gid TEXT NOT NULL, answer TEXT NOT NULL,
        seq INTEGER NOT NULL UNIQUE REFERENCES inbox(seq), rank INTEGER NOT NULL, PRIMARY KEY(aid,q,gid), UNIQUE(aid,q,rank),
        FOREIGN KEY(aid,q) REFERENCES questions(aid,q), FOREIGN KEY(aid,gid) REFERENCES groups_(aid,id));
      CREATE TABLE IF NOT EXISTS marks(book TEXT, tab INTEGER, cell TEXT, job TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(book,tab,cell));
      CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY, teacher TEXT REFERENCES teachers(name), expires INTEGER);
      CREATE TABLE IF NOT EXISTS fixture_books(book TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
    `)
    if (
      !this.all('PRAGMA table_info(activities)').some(
        (c) => c.name === 'import_revision',
      )
    ) {
      this.sql.exec(
        'ALTER TABLE activities ADD COLUMN import_revision INTEGER NOT NULL DEFAULT 0',
      )
    }
    if (
      !this.all('PRAGMA table_info(questions)').some(
        (c) => c.name === 'published_at',
      )
    ) {
      this.sql.exec('ALTER TABLE questions ADD COLUMN published_at INTEGER')
    }
  }
  one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.sql.prepare(sql).get(...args)
  }
  all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.sql.prepare(sql).all(...args)
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.sql.prepare(sql).run(...args)
  }
  tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.sql.exec('COMMIT')
      return value
    } catch (e) {
      this.sql.exec('ROLLBACK')
      throw e
    }
  }
  teacher(name: string, password: string) {
    check(
      name.trim() &&
        !name.startsWith('<') &&
        password.length >= 8 &&
        password !== '<initial-password>',
      '請提供教師帳號與至少八字元的密碼',
    )
    const salt = key()
    this.run(
      'INSERT INTO teachers(name,salt,hash) VALUES(?,?,?)',
      name,
      salt,
      scryptSync(password, salt, 32).toString('hex'),
    )
  }
  login(name: string, password: string) {
    const t = this.one('SELECT * FROM teachers WHERE name=?', name)
    const actual = scryptSync(password, t?.salt ?? 'unknown-account', 32)
    check(
      t && timingSafeEqual(Buffer.from(t.hash, 'hex'), actual),
      '帳號或密碼錯誤',
      401,
    )
    return this.session(name, null)
  }
  session(teacher: string | null, aid: string | null) {
    const token = key()
    this.run(
      'INSERT INTO sessions(token,teacher,aid,expires) VALUES(?,?,?,?)',
      digest(token),
      teacher,
      aid,
      Date.now() + 86400000,
    )
    return token
  }
  close() {
    this.sql.close()
  }
}
export const dbPath = () => process.env.QUIZ_DB ?? 'data/classroom.sqlite'
