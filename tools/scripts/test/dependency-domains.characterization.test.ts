// Frozen characterization (TL-04): where runtime and source packages resolve,
// and which React the shared UI renders with, before the root manifest drops
// Desktop-only declarations. Do not edit; policy checks live in
// dependency-domains.test.ts.
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement, useState } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { create } from 'zustand'

const root = resolve(import.meta.dirname, '../../..')

/** Directory Node's node_modules lookup finds for `name` from `importer`. */
function packageDir(importer: string, name: string): string {
  const lookup = createRequire(join(root, importer)).resolve.paths(name) ?? []
  const found = lookup
    .map((base) => join(base, name))
    .find((dir) => existsSync(join(dir, 'package.json')))
  if (!found) throw new Error(`${name} does not resolve from ${importer}`)
  return realpathSync(found)
}

function expectInstalledIn(importer: string, names: string[], domain: string) {
  const install = realpathSync(join(root, domain))
  for (const name of names) {
    const path = relative(install, packageDir(importer, name))
    expect({ name, path }).toEqual({ name, path: name })
    expect(isAbsolute(path)).toBe(false)
  }
}

const sharedUiPackages = [
  '@floating-ui/dom',
  '@tanstack/react-virtual',
  '@xterm/addon-fit',
  '@xterm/addon-search',
  '@xterm/addon-web-links',
  '@xterm/xterm',
  'chart.js',
  'clsx',
  'katex',
  'luxon',
  'mermaid',
  'monaco-editor',
  'react',
  'react-dom',
  'react-markdown',
  'react-resizable-panels',
  'rehype-katex',
  'remark-gfm',
  'remark-math',
  'shiki',
  'unicode-emoji-json',
  'vega-embed',
  'zustand',
]

describe('dependency install domains (characterization)', () => {
  it('resolves Desktop main-process and renderer packages from the app install', () => {
    expectInstalledIn(
      'apps/desktop/electron/main.ts',
      ['chokidar', 'electron-store', 'electron-updater', 'node-pty', 'electron'],
      'apps/desktop/node_modules',
    )
    expectInstalledIn(
      'apps/desktop/src/main.tsx',
      ['react', 'react-dom'],
      'apps/desktop/node_modules',
    )
  })

  it('resolves shared UI, library, Host and Web packages from the root install', () => {
    expectInstalledIn('libs/client-ui/src/app/App.tsx', sharedUiPackages, 'node_modules')
    expectInstalledIn('libs/shared/src/ipc.ts', ['cron-parser', 'luxon'], 'node_modules')
    expectInstalledIn('libs/pi-extensions/pi-ext/swarm.ts', ['typebox'], 'node_modules')
    expectInstalledIn('apps/host/src/cli.ts', ['ws', 'esbuild'], 'node_modules')
    expectInstalledIn('apps/web/vite.config.ts', ['cron-parser', 'zustand', 'clsx'], 'node_modules')
  })

  it('resolves Control packages from its own install', () => {
    expectInstalledIn(
      'apps/control/src/app.ts',
      ['hono', '@hono/node-server', 'esbuild'],
      'apps/control/node_modules',
    )
  })

  it('links source libraries to this checkout from every root-resolved importer', () => {
    for (const importer of ['apps/host/src/cli.ts', 'apps/desktop/electron/main.ts']) {
      for (const library of ['shared', 'session-runtime', 'host-client', 'pi-extensions']) {
        expect(packageDir(importer, `@phosphor/${library}`)).toBe(
          realpathSync(join(root, 'libs', library)),
        )
      }
    }
  })

  it('gives the shared UI and its React consumers one React copy', () => {
    const react = packageDir('libs/client-ui/src/app/App.tsx', 'react')
    for (const consumer of [
      'react-dom',
      'zustand',
      'react-markdown',
      '@tanstack/react-virtual',
      'react-resizable-panels',
    ]) {
      const consumerDir = relative(root, packageDir('libs/client-ui/src/app/App.tsx', consumer))
      expect({ consumer, react: packageDir(join(consumerDir, 'index.js'), 'react') }).toEqual({
        consumer,
        react,
      })
    }
  })

  it('renders a zustand-backed hook through react-dom with that single React', () => {
    const useProbe = create(() => ({ label: 'one' }))
    function Probe() {
      const label = useProbe((state) => state.label)
      const [suffix] = useState('-react')
      return createElement('b', null, `${label}${suffix}`)
    }
    expect(renderToString(createElement(Probe))).toBe('<b>one-react</b>')
  })

  it('dedupes React onto one app copy in the Desktop and Web renderer builds', async () => {
    type RendererConfig = { resolve?: { dedupe?: string[] } }
    const load = async (file: string) =>
      ((await import(pathToFileURL(join(root, file)).href)) as { default: unknown }).default
    const desktop = (await load('apps/desktop/electron.vite.config.ts')) as {
      renderer?: RendererConfig
    }
    const web = (await load('apps/web/vite.config.ts')) as RendererConfig
    for (const dedupe of [desktop.renderer?.resolve?.dedupe, web.resolve?.dedupe]) {
      expect(dedupe).toEqual(expect.arrayContaining(['react', 'react-dom']))
    }
  })
})
