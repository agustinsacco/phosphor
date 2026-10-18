import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { describe, expect, it } from 'vitest'

const library = resolve(import.meta.dirname, '../..')
const root = resolve(library, '../..')
const manifest = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8'))
const tsconfig = join(library, 'tsconfig.json')
const portableRuntime: Plugin = {
  name: 'portable-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => {
      throw new Error('Session runtime must not import Electron')
    })
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
      if (
        ['electron', 'src'].some((directory) =>
          path.startsWith(join(root, 'apps/desktop', directory) + sep),
        ) ||
        path.startsWith(join(root, 'libs/client-ui') + sep)
      ) {
        throw new Error('Session runtime must not import Desktop source')
      }
    })
  },
}

describe('session runtime source package boundary', () => {
  it('exports every production module without tests or fake-pi fixtures', () => {
    const files = readdirSync(join(library, 'src'), { recursive: true })
      .map(String)
      .filter(
        (name) =>
          name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.includes('__fixtures__'),
      )
      .sort()
    expect(manifest.name).toBe('@phosphor/session-runtime')
    expect(manifest.private).toBe(true)
    expect(Object.keys(manifest.exports).sort()).toEqual(
      files.map((name) => `./${name.slice(0, -3).replaceAll('\\', '/')}`).sort(),
    )
    for (const file of files) {
      expect(manifest.exports[`./${file.slice(0, -3).replaceAll('\\', '/')}`]).toEqual({
        types: `./src/${file.replaceAll('\\', '/')}`,
        default: `./src/${file.replaceAll('\\', '/')}`,
      })
    }
  })

  it('bundles every session runtime entry for plain Node without Desktop imports', async () => {
    const entryPoints = Object.values(manifest.exports).map((entry) =>
      join(library, (entry as { default: string }).default),
    )
    const result = await build({
      absWorkingDir: library,
      entryPoints,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      outdir: 'unused',
      metafile: true,
      tsconfig,
      plugins: [portableRuntime],
    })
    expect(
      Object.keys(result.metafile.inputs).filter((path) => /(^|\/)electron\//.test(path)),
    ).toEqual([])
    expect(result.outputFiles).toHaveLength(entryPoints.length)
    for (const output of Object.values(result.metafile.outputs)) {
      expect(output.imports.filter((entry) => entry.external && !isBuiltin(entry.path))).toEqual([])
    }
  })

  it.each([
    'electron',
    './apps/desktop/electron/store',
    './apps/desktop/src/main',
    './libs/client-ui/src/lib/format',
  ])('rejects the forbidden import fixture %s', async (path) => {
    await expect(
      build({
        absWorkingDir: library,
        stdin: { contents: `import ${JSON.stringify(path)}`, resolveDir: root, loader: 'ts' },
        bundle: true,
        platform: 'node',
        write: false,
        tsconfig,
        logLevel: 'silent',
        plugins: [portableRuntime],
      }),
    ).rejects.toThrow(/Session runtime must not import/)
  })
})
