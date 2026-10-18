import { isBuiltin } from 'node:module'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { build, type BuildOptions, type Plugin } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { BUNDLED_EXTENSION_FILES } from '../../session-runtime/src/bundled-extensions'

const source = import.meta.dirname
const library = resolve(source, '..')
const manifest = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string }>
}

function siblingBoundary(directory: string, browser = false): Plugin {
  const inside = (path: string): boolean => {
    const local = relative(realpathSync(directory), path)
    return local !== '..' && !local.startsWith('../') && !isAbsolute(local)
  }
  return {
    name: 'extension-siblings-only',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return
        if (isBuiltin(args.path) || args.path === 'typebox') {
          if (browser) throw new Error(`Browser extension reached ${args.path}`)
          return { path: args.path, external: true }
        }
        if (!args.path.startsWith('.') && !isAbsolute(args.path))
          throw new Error(`Extension import is not a sibling: ${args.path}`)
        if (!inside(resolve(args.resolveDir, args.path)))
          throw new Error(`Extension import is not a sibling: ${args.path}`)
      })
      builder.onLoad({ filter: /.*/ }, (args) => {
        if (!inside(args.path)) throw new Error(`Extension loaded a non-sibling: ${args.path}`)
      })
    },
  }
}

function options(directory: string, browser = false): BuildOptions {
  return {
    absWorkingDir: directory,
    bundle: true,
    platform: browser ? 'browser' : 'node',
    format: 'esm',
    write: false,
    outdir: 'unused',
    metafile: true,
    logLevel: 'silent',
    tsconfigRaw: { compilerOptions: { paths: {} } },
    plugins: [siblingBoundary(directory, browser)],
  }
}

describe('pi extension package boundary', () => {
  it('exports the shipped sibling source tree, excluding tests', () => {
    const files = readdirSync(source, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .sort()
    expect(Object.keys(manifest.exports).sort()).toEqual(
      files.map((file) => `./${file.slice(0, -3)}`).sort(),
    )
    for (const file of files) {
      expect(manifest.exports[`./${file.slice(0, -3)}`]).toEqual({
        types: `./pi-ext/${file}`,
        default: `./pi-ext/${file}`,
      })
    }
  })

  it('recursively resolves every bundled entry through shipped siblings only', async () => {
    const result = await build({ ...options(source), entryPoints: [...BUNDLED_EXTENSION_FILES] })
    expect(result.outputFiles).toHaveLength(6)
    for (const input of Object.keys(result.metafile!.inputs)) {
      expect(manifest.exports[`./${input.slice(0, -3)}`]).toBeDefined()
      expect(input).not.toContain('.test.')
    }
    for (const output of Object.values(result.metafile!.outputs)) {
      expect(
        output.imports.every((entry) => isBuiltin(entry.path) || entry.path === 'typebox'),
      ).toBe(true)
    }
  })

  it.each(['swarm', 'lane-reload', 'subagent-snapshot', 'status-keys'])(
    'bundles %s and its transitive closure for the browser without Node',
    async (entry) => {
      const result = await build({ ...options(source, true), entryPoints: [`${entry}.ts`] })
      expect(result.outputFiles).toHaveLength(1)
      expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports)).toEqual(
        [],
      )
    },
  )

  it.each([
    '@phosphor/shared/rpc',
    '@shared/rpc',
    '@/lib/rpc',
    '@earendil-works/pi-coding-agent',
    '../../../apps/desktop/electron/store',
    '../../../apps/host/src/main',
  ])('rejects transitive app/package-alias import %s', async (specifier) => {
    await rejectsTransitive(specifier, false, /Extension import is not a sibling/)
  })

  it.each(['node:fs', 'fs', 'node:child_process', 'typebox'])(
    'rejects transitive browser runtime import %s',
    async (specifier) => {
      await rejectsTransitive(specifier, true, /Browser extension reached/)
    },
  )
})

async function rejectsTransitive(specifier: string, browser: boolean, error: RegExp) {
  const directory = mkdtempSync(join(tmpdir(), 'phosphor-extension-boundary-'))
  try {
    writeFileSync(join(directory, 'entry.ts'), "import './sibling'")
    writeFileSync(join(directory, 'sibling.ts'), `import ${JSON.stringify(specifier)}`)
    await expect(
      build({ ...options(directory, browser), entryPoints: ['entry.ts'] }),
    ).rejects.toThrow(error)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
