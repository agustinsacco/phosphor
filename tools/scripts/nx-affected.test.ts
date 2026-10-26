import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_PROJECTS } from './release-scope.mjs'

// What each file selects decides which apps a release ships (release-scope.mjs).
const root = resolve(import.meta.dirname, '../..')

describe('actual Nx affected measurements (per-app inputs)', () => {
  const nx = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(root, 'node_modules/nx/dist/bin/nx.js'),
          'show',
          'projects',
          '--affected',
          ...args,
          '--json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
        },
      ),
    )
  // Control's stack test consumes Desktop auth; Web consumes Control and Host.
  // Library changes also select their transitive app consumers.
  const desktop = ['desktop', 'control', 'web', 'tooling']
  const host = ['host', 'web', 'tooling']
  const runtime = ['desktop', 'control', 'host', 'runtime', 'web', 'tooling']
  const extensions = [
    'desktop',
    'control',
    'host',
    'pi-extensions',
    'runtime',
    'client-ui',
    'web',
    'site',
    'tooling',
  ]
  const libraries = [
    'client-ui',
    'web',
    'control',
    'desktop',
    'host',
    'host-client',
    'pi-extensions',
    'runtime',
    'shared',
    'tooling',
  ]
  // Site and Desktop never select each other; docs and CI select only the
  // whole-workspace checks. Root install/config keep Nx's select-everything rule.
  it.each([
    ['apps/site/src/pages/index.astro', ['site', 'tooling']],
    ['apps/site/package-lock.json', ['site', 'tooling']],
    ['.infra/phosphor-site/base/deployment.yaml', ['site', 'tooling']],
    ['tools/scripts/site-web-config.mjs', ['site', 'tooling']],
    ['tools/scripts/site-web-smoke.mjs', ['site', 'tooling']],
    ['.github/workflows/deploy-site.yml', ['site', 'tooling']],
    ['apps/desktop/src/main.tsx', desktop],
    ['apps/desktop/electron/account/gotrue.ts', desktop],
    ['apps/desktop/electron/account/loopback.ts', desktop],
    [
      'libs/client-ui/src/compact.ts',
      ['client-ui', 'desktop', 'control', 'web', 'site', 'tooling'],
    ],
    ['apps/web/src/main.tsx', ['web', 'site', 'tooling']],
    ['apps/desktop/package-lock.json', desktop],
    ['tools/scripts/fix-node-pty.mjs', desktop],
    ['tools/scripts/install.sh', desktop],
    ['.github/workflows/release-continuous.yml', desktop],
    ['apps/host/src/main.ts', host],
    ['apps/control/src/main.ts', ['control', 'web', 'site', 'tooling']],
    ['apps/host/project.json', host],
    ['libs/pi-extensions/pi-ext/headroom.ts', extensions],
    ['libs/session-runtime/src/pi/session-service.ts', runtime],
    [
      'libs/host-client/src/connection.ts',
      ['desktop', 'control', 'host', 'host-client', 'runtime', 'web', 'site', 'tooling'],
    ],
    ['libs/shared/src/ipc.ts', [...libraries, 'site']],
    ['supabase/config.toml', ['schema', 'tooling']],
    ['tools/scripts/validate.sh', ['tooling']],
    ['.github/workflows/ci.yml', ['tooling']],
    ['docs/README.md', ['tooling']],
    ['README.md', ['tooling']],
    ['nx.json', ALL_PROJECTS],
    ['package.json', ALL_PROJECTS],
    ['package-lock.json', ALL_PROJECTS],
  ])('%s selects %j', (file, expected) => {
    expect(nx(`--files=${file}`).sort()).toEqual([...expected].sort())
  })
  it('equal actual base/head is an unambiguous no-op', () => {
    const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    expect(nx(`--base=${checkedOut}`, `--head=${checkedOut}`)).toEqual([])
  })
})

it('includes every registered project in the fail-closed CI and release inventory', () => {
  const files = globSync('**/project.json', {
    cwd: root,
    exclude: ['**/node_modules/**', '.nx/**', '.phosphor/**', '**/dist/**', '**/out/**'],
  })
  const names = files.map((path) => {
    const config: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'))
    if (
      !config ||
      typeof config !== 'object' ||
      !('name' in config) ||
      typeof config.name !== 'string'
    ) {
      throw new Error('Invalid project registration')
    }
    return config.name
  })
  expect([...ALL_PROJECTS].sort()).toEqual(names.sort())
})
