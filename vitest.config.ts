import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'libs/shared/src'),
      '@phosphor/shared': resolve(import.meta.dirname, 'libs/shared/src'),
      '@phosphor/host-client': resolve(import.meta.dirname, 'libs/host-client/src'),
      '@phosphor/session-runtime': resolve(import.meta.dirname, 'libs/session-runtime/src'),
      '@': resolve(import.meta.dirname, 'libs/client-ui/src'),
    },
  },
  test: {
    include: [
      'apps/desktop/*.test.ts',
      'apps/desktop/src/**/*.{test.ts,test.tsx}',
      'apps/desktop/scripts/**/*.test.ts',
      'apps/desktop/electron/**/*.test.ts',
      'apps/host/src/**/*.test.ts',
      'apps/control/src/**/*.test.ts',
      'apps/web/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'apps/web/src/**/*.test.tsx',
      'apps/control/scripts/**/*.test.ts',
      'apps/host/scripts/**/*.test.ts',
      'libs/session-runtime/src/**/*.test.ts',
      'libs/host-client/src/**/*.test.ts',
      'libs/shared/src/**/*.test.ts',
      // Keep adjacent bundled-extension tests discoverable during relocation.
      'libs/pi-extensions/pi-ext/**/*.test.ts',
      'libs/client-ui/src/**/*.test.ts',
      'libs/client-ui/src/**/*.test.tsx',
      // Release-pipeline shell helpers that CI depends on.
      'tools/scripts/**/*.test.ts',
      'tools/host-release/**/*.test.ts',
      // Relocated suites coexist with adjacent tests during the migration.
      'apps/desktop/test/**/*.{test.ts,test.tsx}',
      'apps/host/test/**/*.test.ts',
      'apps/control/test/**/*.test.ts',
      'libs/{shared,session-runtime,pi-extensions,host-client}/test/**/*.test.ts',
      'libs/client-ui/test/**/*.{test.ts,test.tsx}',
      'apps/web/test/**/*.{test.ts,test.tsx}',
      'tools/{scripts,host-release}/test/**/*.test.ts',
    ],
    // Node by default; DOM-dependent suites opt in per file with
    // `// @vitest-environment jsdom` so the fast majority stay in node.
    environment: 'node',
    // Enabled only by the unit runner, with explicit owned-source includes.
    // No global threshold: existing unmeasured coverage is not a baseline.
    coverage: { provider: 'v8', reporter: ['json'] },
  },
})
