import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Linux: absorb Electron's first launch, which never paints (see the file).
  globalSetup: './e2e/warm-up.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Only affects CI: lets `--shard` split individual tests (not just files)
  // across shard jobs. workers stays 1, so execution within a shard is
  // still fully serial — this doesn't change local runs.
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
