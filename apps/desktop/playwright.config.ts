import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Linux: absorb Electron's first launch, which never paints (see the file).
  globalSetup: './e2e/warm-up.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Lets `--shard` and `--workers` split individual tests, not just files. Local
  // runs stay serial (workers 1); Linux CI passes --workers (see ci.yml).
  fullyParallel: true,
  workers: 1,
  // Hidden windows still share the OS clipboard with the person using this
  // computer. Native clipboard cases run in CI or with explicit local consent.
  grepInvert:
    process.env.CI || process.env.PHOSPHOR_E2E_CLIPBOARD === '1' ? undefined : /@system-clipboard/,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
