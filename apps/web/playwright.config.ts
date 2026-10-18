import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

export const evidence = resolve(process.env.WEB_E2E_EVIDENCE ?? '/tmp/phosphor-web-e2e')
export default defineConfig({
  testDir: './e2e',
  tsconfig: './e2e/tsconfig.json',
  globalSetup: './e2e/build.ts',
  outputDir: resolve(evidence, 'results'),
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  // Traces include cookies and grants. Never record them, even for synthetic accounts.
  use: { trace: 'off', screenshot: 'only-on-failure', viewport: { width: 400, height: 850 } },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
})
