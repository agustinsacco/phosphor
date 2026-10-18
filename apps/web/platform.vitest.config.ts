import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
export default defineConfig({
  resolve: {
    alias: [
      { find: '@phosphor/shared', replacement: `${root}libs/shared/src` },
      { find: '@shared', replacement: `${root}libs/shared/src` },
      { find: '@phosphor/host-client', replacement: `${root}libs/host-client/src` },
    ],
  },
  test: {
    maxWorkers: 2,
    include: [
      'apps/web/src/platform/**/*.test.ts',
      'libs/shared/src/ipc-web.test.ts',
      'libs/host-client/src/{read-features,machine-reads,repository-reads,artifacts,routines}.test.ts',
    ],
  },
})
