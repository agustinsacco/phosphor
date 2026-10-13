import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { isBuiltin } from 'node:module'
import { build, type Plugin } from 'esbuild'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const library = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(library, 'package.json'), 'utf8'))
const portableShared: Plugin = {
  name: 'portable-shared',
  setup(builder) {
    builder.onResolve({ filter: /^(?:node:|electron(?:\/|$)|vitest(?:\/|$))/ }, ({ path }) => {
      throw new Error(`Shared source cannot import ${path}`)
    })
  },
}

// Private source exports are build inputs, never external runtime dependencies.
// @shared/* remains the sole compatibility alias until installation closure.
describe('shared source package boundary', () => {
  it('exports the entire production source set, without tests', () => {
    const files = readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .sort()
    expect(manifest.name).toBe('@phosphor/shared')
    expect(manifest.private).toBe(true)
    expect(Object.keys(manifest.exports).sort()).toEqual(
      [...files.map((name) => `./${name.slice(0, -3)}`), './host-protocol-testing'].sort(),
    )
    expect(manifest.exports['./host-protocol-testing']).toEqual({
      types: './src/host-protocol-testing/index.ts',
      default: './src/host-protocol-testing/index.ts',
    })
    for (const file of files) {
      expect(manifest.exports[`./${file.slice(0, -3)}`]).toEqual({
        types: `./src/${file}`,
        default: `./src/${file}`,
      })
    }
  })

  it('bundles every export for browser and plain Node without application inputs', async () => {
    const entryPoints = Object.entries(manifest.exports)
      .filter(([name]) => name !== './host-protocol-testing')
      .map(([, entry]) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          !('default' in entry) ||
          typeof entry.default !== 'string'
        )
          throw new Error('Invalid package export')
        return resolve(library, entry.default)
      })
    for (const platform of ['browser', 'node'] as const) {
      const result = await build({
        absWorkingDir: root,
        entryPoints,
        bundle: true,
        platform,
        format: 'esm',
        write: false,
        outdir: 'unused',
        metafile: true,
        tsconfig: 'tsconfig.base.json',
        plugins: [portableShared],
      })
      expect(
        Object.keys(result.metafile.inputs).filter((path) =>
          /^apps\/desktop\/(electron|src)\//.test(path),
        ),
      ).toEqual([])
      expect(result.outputFiles).toHaveLength(entryPoints.length)
      for (const output of Object.values(result.metafile.outputs)) {
        expect(
          output.imports.filter(
            (entry) => entry.external && (platform === 'browser' || !isBuiltin(entry.path)),
          ),
        ).toEqual([])
      }
    }
  })

  it('keeps the fake Host and transport portable, with vitest confined to conformance', async () => {
    const kit = resolve(library, 'src/host-protocol-testing')
    for (const name of readdirSync(kit).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )) {
      const tree = ts.createSourceFile(
        name,
        readFileSync(resolve(kit, name), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      function visit(node: ts.Node) {
        if (ts.isStringLiteralLike(node)) {
          const parent = node.parent
          if (
            ts.isImportDeclaration(parent) ||
            ts.isExportDeclaration(parent) ||
            (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
            ts.isExternalModuleReference(parent) ||
            (ts.isCallExpression(parent) &&
              (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')))
          ) {
            expect(node.text.startsWith('node:'), `${name}: ${node.text}`).toBe(false)
            if (node.text === 'vitest' || node.text.startsWith('vitest/'))
              expect(name).toBe('conformance.ts')
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    const entryPoints = ['loopback.ts', 'fake-host.ts'].map((name) => resolve(kit, name))
    for (const platform of ['browser', 'node'] as const) {
      const result = await build({
        absWorkingDir: root,
        entryPoints,
        bundle: true,
        platform,
        format: 'esm',
        write: false,
        outdir: 'unused',
        metafile: true,
        tsconfig: 'tsconfig.base.json',
        plugins: [portableShared],
      })
      expect(result.outputFiles).toHaveLength(2)
      for (const output of Object.values(result.metafile.outputs))
        expect(output.imports).toEqual([])
    }
  })
})
