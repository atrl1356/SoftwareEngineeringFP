import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { application } from './app'
import { dbPath, Store } from './db'
if (existsSync('.env')) loadEnvFile('.env')
const db = new Store(dbPath())
const app = application({ db })
const address = await app.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
})
console.log('課堂搶答室 ' + address)
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, async () => {
    await app.close()
    db.close()
  })
