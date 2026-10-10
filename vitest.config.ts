import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'libs/shared/src'),
      '@phosphor/shared': resolve(import.meta.dirname, 'libs/shared/src'),
      '@phosphor/session-runtime': resolve(import.meta.dirname, 'libs/session-runtime/src'),
      '@': resolve(import.meta.dirname, 'apps/desktop/src'),
    },
  },
  test: {
    include: [
      'apps/desktop/*.test.ts',
      'apps/desktop/scripts/**/*.test.ts',
      'apps/desktop/electron/**/*.test.ts',
      'apps/host/src/**/*.test.ts',
      'apps/host/scripts/**/*.test.ts',
      'libs/session-runtime/src/**/*.test.ts',
      'libs/shared/src/**/*.test.ts',
      // Bundled pi extensions: pure rule logic lives beside the extension it
      // guards, because pi loads each `-e` file standalone (no local imports).
      'libs/pi-extensions/pi-ext/**/*.test.ts',
      'apps/desktop/src/**/*.test.ts',
      'apps/desktop/src/**/*.test.tsx',
      // Release-pipeline shell helpers that CI depends on.
      'tools/scripts/**/*.test.ts',
    ],
    // Node by default; DOM-dependent suites opt in per file with
    // `// @vitest-environment jsdom` so the fast majority stay in node.
    environment: 'node',
  },
})
