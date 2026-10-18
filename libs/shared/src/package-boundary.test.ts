import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { isBuiltin } from 'node:module'
import { build, type Plugin } from 'esbuild'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function sharedLibrary(start: string): string {
  let directory = start
  while (true) {
    const path = join(directory, 'package.json')
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === '@phosphor/shared')
      return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot find shared package from ${start}`)
    directory = parent
  }
}
const library = sharedLibrary(import.meta.dirname)
const root = resolve(library, '../..')
const sourceRoot = resolve(library, 'src')
const manifest = JSON.parse(readFileSync(resolve(library, 'package.json'), 'utf8'))
const portableShared: Plugin = {
  name: 'portable-shared',
  setup(builder) {
    builder.onResolve({ filter: /^(?:node:|electron(?:\/|$)|vitest(?:\/|$))/ }, ({ path }) => {
      throw new Error(`Shared source cannot import ${path}`)
    })
  },
}

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory())
      return ['__fixtures__', '__tests__', 'test', 'tests'].includes(entry.name)
        ? []
        : productionSources(file)
    return /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ? [file] : []
  })
}

function publicExportViolations(directory: string, exports: Record<string, unknown>): string[] {
  const expected: Record<string, string> = {
    './host-protocol-testing': './src/host-protocol-testing/index.ts',
  }
  for (const file of productionSources(directory).filter((file) => dirname(file) === directory)) {
    const name = relative(directory, file)
    expected[`./${name.replace(/\.[cm]?[jt]sx?$/, '')}`] = `./src/${name}`
  }
  const violations: string[] = []
  for (const name of new Set([...Object.keys(expected), ...Object.keys(exports)])) {
    if (!(name in expected)) violations.push(`Unexpected export: ${name}`)
    else {
      const entry = exports[name]
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('types' in entry) ||
        !('default' in entry) ||
        Object.keys(entry).sort().join(',') !== 'default,types' ||
        entry.types !== expected[name] ||
        entry.default !== expected[name]
      )
        violations.push(`Missing or invalid export: ${name}`)
    }
  }
  return violations
}

function moduleSpecifiers(file: string, text: string): string[] {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent
      if (
        ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        ts.isExternalModuleReference(parent) ||
        (ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')))
      )
        imports.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return imports
}

function portableSourceViolations(directory: string): string[] {
  return productionSources(directory).flatMap((file) => {
    const name = relative(directory, file).split('\\').join('/')
    const conformance =
      name === 'host-protocol-testing/conformance.ts' ||
      name.startsWith('host-protocol-testing/conformance/')
    return moduleSpecifiers(file, readFileSync(file, 'utf8'))
      .filter(
        (target) =>
          isBuiltin(target) ||
          /^electron(?:\/|$)/.test(target) ||
          (!conformance && /^vitest(?:\/|$)/.test(target)),
      )
      .map((target) => `${name}: ${target}`)
  })
}

function withSources(files: Record<string, string>, check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'shared-boundary-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = join(directory, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    check(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// Private source exports are build inputs, never external runtime dependencies.
// @shared/* remains the sole compatibility alias until installation closure.
describe('shared source package boundary', () => {
  it('exports the entire production source set, without tests', () => {
    expect(manifest.name).toBe('@phosphor/shared')
    expect(manifest.private).toBe(true)
    expect(publicExportViolations(sourceRoot, manifest.exports)).toEqual([])
  })

  it('checks every production module, including private domain modules', () => {
    expect(portableSourceViolations(sourceRoot)).toEqual([])
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
    expect(portableSourceViolations(sourceRoot)).toEqual([])
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

describe('shared boundary characterization', () => {
  it('bundles the public testing entry separately with only vitest external', async () => {
    for (const platform of ['browser', 'node'] as const) {
      const result = await build({
        entryPoints: [resolve(library, manifest.exports['./host-protocol-testing'].default)],
        bundle: true,
        platform,
        format: 'esm',
        write: false,
        metafile: true,
        external: ['vitest'],
      })
      expect(
        Object.keys(result.metafile.inputs).some((file) => file.endsWith('fake-host.ts')),
      ).toBe(true)
      expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([
        { path: 'vitest', kind: 'import-statement', external: true },
      ])
    }
  })

  it('rejects Node, Electron and vitest in portable bundles', async () => {
    for (const target of ['node:fs', 'electron', 'vitest']) {
      await expect(
        build({
          stdin: { contents: `import ${JSON.stringify(target)}`, resolveDir: library },
          bundle: true,
          write: false,
          logLevel: 'silent',
          plugins: [portableShared],
        }),
      ).rejects.toThrow(`Shared source cannot import ${target}`)
    }
  })
})

describe('recursive shared boundary checks', () => {
  it.each([
    "import { readFile } from 'node:fs'",
    "import type { Stats } from 'fs'",
    "export * from 'node:path'",
    "export type { Stats } from 'node:fs'",
    "const module = import('electron')",
    "type Module = import('node:fs').Stats",
    "const module = require('vitest')",
    "import module = require('vitest/config')",
  ])('rejects a private, unexported module containing %s', (text) => {
    withSources({ 'domain/deep/private.ts': text }, (directory) => {
      expect(portableSourceViolations(directory)).toHaveLength(1)
      expect(portableSourceViolations(directory)[0]).toContain('domain/deep/private.ts: ')
    })
  })

  it('keeps private modules private while requiring every top-level export', () => {
    withSources(
      {
        'public.ts': "export * from './domain/private'",
        'domain/private.ts': 'export const value = 1',
        'domain/deep/types.ts': 'export type Value = number',
        'domain/deep/strings.ts': "// import 'node:fs'\nexport const note = 'vitest'",
        'domain/ignored.test.ts': "import 'node:fs'",
        '__fixtures__/ignored.ts': "import 'node:fs'",
      },
      (directory) => {
        const exports = {
          './public': { types: './src/public.ts', default: './src/public.ts' },
          './host-protocol-testing': {
            types: './src/host-protocol-testing/index.ts',
            default: './src/host-protocol-testing/index.ts',
          },
        }
        expect(publicExportViolations(directory, exports)).toEqual([])
        expect(portableSourceViolations(directory)).toEqual([])
        expect(
          publicExportViolations(directory, {
            './host-protocol-testing': exports['./host-protocol-testing'],
          }),
        ).toEqual(['Missing or invalid export: ./public'])
        expect(publicExportViolations(directory, { ...exports, './domain/private': {} })).toEqual([
          'Unexpected export: ./domain/private',
        ])
        expect(
          publicExportViolations(directory, {
            ...exports,
            './public': { types: './src/public.ts', default: './src/domain/private.ts' },
          }),
        ).toEqual(['Missing or invalid export: ./public'])
      },
    )
  })

  it('allows vitest only in the conformance entry and its private subtree', () => {
    withSources(
      {
        'host-protocol-testing/conformance.ts': "export { it } from 'vitest'",
        'host-protocol-testing/conformance/suites/wire.ts':
          "import type { TestContext } from 'vitest'",
        'host-protocol-testing/helpers/deep/fake.ts': "export * from 'vitest'",
        'host-protocol-testing/conformance-extra/helper.ts': "const kit = import('vitest/config')",
        'domain/conformance.ts': "import 'vitest'",
        'host-protocol-testing/conformance/node.ts': "export * from 'node:fs'",
      },
      (directory) => {
        expect(portableSourceViolations(directory).sort()).toEqual([
          'domain/conformance.ts: vitest',
          'host-protocol-testing/conformance-extra/helper.ts: vitest/config',
          'host-protocol-testing/conformance/node.ts: node:fs',
          'host-protocol-testing/helpers/deep/fake.ts: vitest',
        ])
      },
    )
  })

  it('discovers src from the package, not from a relocated test directory', () => {
    withSources(
      {
        'package.json': JSON.stringify({ name: '@phosphor/shared' }),
        'test/nested/package.json': JSON.stringify({ private: true }),
        'test/nested/boundary.test.ts': '',
        'src/domain/deep/private.ts': "import 'node:fs'",
      },
      (directory) => {
        const library = sharedLibrary(join(directory, 'test/nested'))
        expect(library).toBe(directory)
        expect(portableSourceViolations(join(library, 'src'))).toEqual([
          'domain/deep/private.ts: node:fs',
        ])
      },
    )
  })
})
