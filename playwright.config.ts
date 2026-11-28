import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  timeout: 45000,
  workers: 1,
  use: {
    headless: true,
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    },
  },
})
