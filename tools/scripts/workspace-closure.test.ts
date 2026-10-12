import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const libraries = ['libs/shared', 'libs/session-runtime', 'libs/pi-extensions']

describe('workspace installation closure', () => {
  it('shares only source libraries, never the native Desktop or independently locked site', () => {
    const manifest = json(join(root, 'package.json'))
    expect(manifest.workspaces).toEqual(libraries)
    expect(manifest.scripts.postinstall).toBe(
      'npm ci --prefix apps/desktop && npm ci --prefix apps/control',
    )
    const lock = json(join(root, 'package-lock.json'))
    const require = createRequire(join(root, 'package.json'))
    for (const library of libraries) {
      const source = json(join(root, library, 'package.json'))
      const link = join(root, 'node_modules', source.name)
      expect(lock.packages[`node_modules/${source.name}`]).toEqual({
        resolved: library,
        link: true,
      })
      expect(realpathSync(link)).toBe(join(root, library))
      const [subpath, entry] = Object.entries(source.exports)[0] as [string, { default: string }]
      expect(require.resolve(`${source.name}/${subpath.slice(2)}`)).toBe(
        join(root, library, entry.default),
      )
    }
    for (const app of ['apps/desktop', 'apps/control', 'apps/site']) {
      expect(lock.packages[app]).toBeUndefined()
      expect(existsSync(join(root, app, 'package-lock.json'))).toBe(true)
    }
    for (const dependency of ['electron', 'node-pty', '@electron/rebuild']) {
      expect(existsSync(join(root, 'node_modules', dependency))).toBe(false)
    }
    expect(lstatSync(join(root, 'node_modules')).isSymbolicLink()).toBe(false)
  })

  it('declares directly imported Playwright tooling and app builder test APIs at retained versions', () => {
    const tooling = json(join(root, 'package.json'))
    const require = createRequire(join(root, 'package.json'))
    for (const name of ['playwright', 'playwright-core']) {
      expect(tooling.devDependencies[name]).toBe('1.62.1')
      const path = require.resolve(`${name}/package.json`)
      expect(path).toBe(join(root, 'node_modules', name, 'package.json'))
      expect(json(path).version).toBe('1.62.1')
    }
    const app = join(root, 'apps/desktop')
    expect(json(join(app, 'package.json')).devDependencies['app-builder-lib']).toBe('26.15.3')
    const appRequire = createRequire(join(app, 'package.json'))
    expect(appRequire.resolve('app-builder-lib/package.json')).toBe(
      join(app, 'node_modules/app-builder-lib/package.json'),
    )
  })

  it('bundles real workspace subpath exports rather than shipping TypeScript links', async () => {
    const imports = libraries.flatMap((library) => {
      const manifest = json(join(root, library, 'package.json'))
      return Object.keys(manifest.exports).map((subpath) => `${manifest.name}/${subpath.slice(2)}`)
    })
    const result = await build({
      absWorkingDir: root,
      stdin: {
        contents: imports
          .map((specifier, i) => `export * as entry${i} from ${JSON.stringify(specifier)}`)
          .join('\n'),
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      // Canonical package imports use npm exports. Only the retained legacy
      // spelling inside runtime sources needs a source alias here.
      tsconfigRaw: { compilerOptions: { paths: { '@shared/*': ['./libs/shared/src/*'] } } },
    })
    for (const input of Object.keys(result.metafile.inputs).filter(
      (input) => input !== '<stdin>',
    )) {
      const path = relative(root, realpathSync(resolve(root, input)))
      expect(path.startsWith('..')).toBe(false)
      expect(path).not.toMatch(/apps[\\/]desktop|node_modules[\\/](electron|node-pty)([\\/]|$)/)
    }
    for (const output of Object.values(result.metafile.outputs)) {
      expect(output.imports.filter((entry) => entry.external && !isBuiltin(entry.path))).toEqual([])
    }
  })

  it('requires explicit script suppression for scoped production source installs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phosphor-scoped-install-'))
    try {
      mkdirSync(join(dir, 'libs/runtime'), { recursive: true })
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'scoped-install-fixture',
          private: true,
          workspaces: ['libs/runtime'],
          scripts: {
            postinstall: `node -e "require('fs').writeFileSync('desktop-lifecycle-fired', 'yes')"`,
          },
        }),
      )
      writeFileSync(
        join(dir, 'libs/runtime/package.json'),
        JSON.stringify({ name: '@phosphor/session-runtime', version: '0.0.0' }),
      )
      writeFileSync(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          name: 'scoped-install-fixture',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'scoped-install-fixture',
              hasInstallScript: true,
              workspaces: ['libs/runtime'],
            },
            'libs/runtime': { name: '@phosphor/session-runtime', version: '0.0.0' },
            'node_modules/@phosphor/session-runtime': { resolved: 'libs/runtime', link: true },
          },
        }),
      )
      const args = [
        'ci',
        '--workspace',
        '@phosphor/session-runtime',
        '--omit=dev',
        '--offline',
        '--no-audit',
        '--no-fund',
      ]
      const options = { cwd: dir, encoding: 'utf8' as const }
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        ...options,
        shell: process.platform === 'win32',
      })
      const sentinel = join(dir, 'desktop-lifecycle-fired')
      expect(existsSync(sentinel)).toBe(true)
      rmSync(sentinel)
      execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        [...args, '--ignore-scripts'],
        { ...options, shell: process.platform === 'win32' },
      )
      expect(existsSync(sentinel)).toBe(false)
      expect(realpathSync(join(dir, 'node_modules/@phosphor/session-runtime'))).toBe(
        realpathSync(join(dir, 'libs/runtime')),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
