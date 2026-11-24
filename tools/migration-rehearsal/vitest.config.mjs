import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['tools/migration-rehearsal/*.test.mjs'] } })
