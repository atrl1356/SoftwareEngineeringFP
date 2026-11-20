import { test as base } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { application } from '../server/app'
import { setup } from './support'
import { Problem } from '../server/db'

type Environment = ReturnType<typeof setup> & {
  origin: string
  failNextWrite: () => void
}
export const test = base.extend<{ env: Environment }>({
  env: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'quiz-browser-'))
    const h = setup(join(dir, 'run.sqlite'))
    const write = h.sheets.write.bind(h.sheets)
    let fail = false
    h.sheets.write = async (...args) => {
      if (fail) {
        fail = false
        throw new Problem('Google 拒絕整批寫入', 502)
      }
      await write(...args)
    }
    const app = application({ db: h.db, sheets: h.sheets })
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      await use({
        ...h,
        origin,
        failNextWrite() {
          fail = true
        },
      })
    } finally {
      await app.close()
      h.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
})
export { expect } from '@playwright/test'
