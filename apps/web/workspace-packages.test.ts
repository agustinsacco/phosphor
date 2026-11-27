import { afterEach, expect, it } from 'vitest'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer, type UserConfig, type ViteDevServer } from 'vite'
import webConfig from './vite.config'
import fixtureConfig from './e2e/fixture.vite.config'

// Workspace packages the browser build imports by name. A linked node_modules can point
// these names at another checkout; each build must compile this checkout's sources.
const checkout = realpathSync(resolve(import.meta.dirname, '../..'))
const ENTRIES = [
  ['client-ui', 'compact'],
  ['client-ui', 'bootstrap'],
  ['client-ui', 'styles/index.css'],
  ['pi-extensions', 'subagent-snapshot'],
  ['pi-extensions', 'swarm'],
  ['pi-extensions', 'lane-reload'],
] as const

function manifestTarget(pkg: string, subpath: string): string {
  const dir = resolve(checkout, 'libs', pkg)
  const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { default: string }>
  }
  const target = manifest.exports[`./${subpath}`]!
  return resolve(dir, typeof target === 'string' ? target : target.default)
}

let server: ViteDevServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function resolver(config: UserConfig) {
  server = await createServer({
    ...config,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, ws: false },
  })
  return (id: string) => server!.pluginContainer.resolveId(id)
}

it.each([
  ['web', webConfig],
  ['fixture', fixtureConfig],
])('the %s build resolves workspace package entries to this checkout', async (_, config) => {
  const resolveId = await resolver(config)
  for (const [pkg, subpath] of ENTRIES) {
    const resolved = await resolveId(`@phosphor/${pkg}/${subpath}`)
    expect(resolved?.id).toBe(manifestTarget(pkg, subpath))
  }
})

it.each([
  ['web', webConfig],
  ['fixture', fixtureConfig],
])('the %s build refuses unlisted workspace package subpaths', async (_, config) => {
  const resolveId = await resolver(config)
  for (const id of [
    '@phosphor/client-ui/src/stores/drafts.ts',
    '@phosphor/client-ui/desktop',
    '@phosphor/pi-extensions/pi-ext/brain.ts',
    '@phosphor/pi-extensions',
  ])
    await expect(resolveId(id), id).rejects.toThrow()
})
