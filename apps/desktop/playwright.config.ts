import { defineConfig } from '@playwright/test'

// Linux CI gives each worker its own Xvfb display (tools/scripts/xvfb-workers.sh):
// a display has one focused window, and parallel windows on a shared one take
// focus from each other's tests. Workers load this file, so set it here.
const displays = process.env.PHOSPHOR_E2E_DISPLAYS?.split(',').filter(Boolean)
const worker = Number(process.env.TEST_PARALLEL_INDEX)
if (displays?.length && Number.isInteger(worker))
  process.env.DISPLAY = displays[worker % displays.length]

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
