import { Store, dbPath } from './db'
import { loadEnvFile } from 'node:process'
import { existsSync } from 'node:fs'
if (existsSync('.env')) loadEnvFile('.env')
const db = new Store(dbPath())
try {
  db.teacher(process.env.TEACHER_NAME ?? '', process.env.TEACHER_PASSWORD ?? '')
  console.log('已建立教師帳號')
} finally {
  db.close()
}
