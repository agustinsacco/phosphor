import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['libs/host-client/src/**/*.test.ts'], maxWorkers: 2 },
})
