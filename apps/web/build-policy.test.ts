import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { assertBrowserModule } from './build-policy'

it('the browser parser alias uses the unchanged public parser class', () => {
  const require = createRequire(import.meta.url)
  expect(require('cron-parser/dist/CronExpressionParser.js').CronExpressionParser).toBe(
    require('cron-parser').CronExpressionParser,
  )
})

it.each([
  'node:fs',
  'fs/promises',
  '__vite-browser-external:crypto',
  '/repo/apps/desktop/electron/preload.ts',
  '/repo/apps/desktop/src/main.tsx',
  '/repo/libs/session-runtime/src/pi/session-service.ts',
  '/repo/node_modules/electron-store/index.js',
  '/repo/node_modules/node-pty/lib/index.js',
  '/repo/libs/client-ui/src/stores/drafts.test.ts',
  '/repo/apps/web/src/__fixtures__/account.ts',
  '/repo/apps/desktop/test/renderer/helpers/fakePhosphor.ts',
  '/repo/libs/client-ui/test/helpers/fakePhosphor.ts',
])('rejects forbidden production browser dependency %s', (id) => {
  expect(() => assertBrowserModule(id)).toThrow('Non-browser module')
})
it.each([
  '/repo/libs/client-ui/src/compact.ts',
  '/repo/libs/host-client/src/connection.ts',
  '/repo/libs/shared/src/models.ts',
  '/repo/apps/web/src/platform/index.ts',
  '/repo/node_modules/react/index.js',
  '/repo/node_modules/@iconify/utils/lib/emoji/test/parse.js',
  '\u0000vite/preload-helper.js',
])('accepts browser dependency %s', (id) => {
  expect(() => assertBrowserModule(id)).not.toThrow()
})
