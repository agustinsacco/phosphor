import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
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
  '/repo/libs/brain-runtime/src/service.ts',
  '/repo/libs/brain-runtime/src/embedding/model-manifest.ts',
  'C:\\repo\\libs\\brain-runtime\\src\\controller.ts',
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

it('keeps the 3D graph and Three out of the initial renderer chunk', async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../libs/client-ui/src/features/brain/BrainGraph3D.tsx', import.meta.url),
      ),
    ],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    outdir: 'dist/graph-policy',
    write: false,
    metafile: true,
    tsconfig: fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
  })
  const outputs = Object.values(result.metafile.outputs)
  const entry = outputs.find((output) => output.entryPoint?.endsWith('BrainGraph3D.tsx'))!
  expect(entry.imports.some((item) => item.kind === 'dynamic-import')).toBe(true)
  const initial = outputs.filter((output) => !output.entryPoint?.endsWith('graphScene.ts'))
  for (const output of initial) {
    expect(
      Object.keys(output.inputs).some((id) =>
        /node_modules\/(?:three|3d-force-graph|three-spritetext)\//.test(id),
      ),
    ).toBe(false)
  }
  for (const id of Object.keys(result.metafile.inputs)) assertBrowserModule(id)
})
