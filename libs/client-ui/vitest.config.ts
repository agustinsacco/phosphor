import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, '../shared/src'),
      '@phosphor/shared': resolve(import.meta.dirname, '../shared/src'),
      '@phosphor/host-client': resolve(import.meta.dirname, '../host-client/src'),
      '@phosphor/session-runtime': resolve(import.meta.dirname, '../session-runtime/src'),
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    include: ['libs/client-ui/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    maxWorkers: 2,
  },
})
