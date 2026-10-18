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
import ts from 'typescript'
import { expect, it } from 'vitest'

function sharedSourceRoot(start: string): string {
  let directory = start
  while (true) {
    const manifest = join(directory, 'package.json')
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, 'utf8')).name === '@phosphor/shared'
    )
      return join(directory, 'src')
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot find shared package from ${start}`)
    directory = parent
  }
}
const sourceRoot = sharedSourceRoot(import.meta.dirname)
const root = resolve(sourceRoot, '../../..')
const kit = join(sourceRoot, 'host-protocol-testing')
const excluded = new Set(['node_modules', 'dist', 'out', 'build', '.astro', '.git', 'release'])
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) return excluded.has(entry.name) ? [] : sources(file)
    return (file.endsWith('.astro') || /\.[cm]?[jt]sx?$/.test(file)) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
      ? [file]
      : []
  })
}
function forbiddenImports(file: string, text: string, kitDirectory = kit): string[] {
  if (file.endsWith('.astro')) {
    const frontmatter = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
    // A quoted attribute may hold `>`, so the opening tag is read quote by quote.
    const scripts = [
      ...text.matchAll(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script\s*>/gi),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    return [...(frontmatter === undefined ? [] : [frontmatter]), ...scripts].flatMap((source) =>
      forbiddenImports(file + '.ts', source, kitDirectory),
    )
  }
  const imports: string[] = []
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent
      if (
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        (ts.isCallExpression(parent) &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'))) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        ts.isExternalModuleReference(parent)
      ) {
        const target = node.text.startsWith('.') ? resolve(dirname(file), node.text) : node.text
        if (
          target.includes('host-protocol-testing') ||
          target === kitDirectory ||
          target.startsWith(kitDirectory + '/')
        )
          imports.push(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return imports
}

function productionViolations(repository: string, kitDirectory: string): string[] {
  return ['apps', 'libs']
    .flatMap((directory) => sources(join(repository, directory)))
    .filter((file) => !file.startsWith(kitDirectory + '/'))
    .flatMap((file) =>
      forbiddenImports(file, readFileSync(file, 'utf8'), kitDirectory).map(
        (target) => `${relative(repository, file)}: ${target}`,
      ),
    )
}

it('keeps host-protocol-testing out of every production source in apps and libs', () => {
  expect(productionViolations(root, kit)).toEqual([])
})
it('detects static, dynamic, type, require and relative imports but not comments', () => {
  const file = join(root, 'apps/host/src/example.ts')
  for (const text of [
    "import { createFakeHost } from '@phosphor/shared/host-protocol-testing'",
    "export * from '../../../libs/shared/src/host-protocol-testing'",
    "const kit = import('@phosphor/shared/host-protocol-testing')",
    "const kit = require('@phosphor/shared/host-protocol-testing')",
    "type Kit = import('@phosphor/shared/host-protocol-testing').FrameSocket",
    "import kit = require('@phosphor/shared/host-protocol-testing')",
  ])
    expect(forbiddenImports(file, text)).toHaveLength(1)
  expect(forbiddenImports(file, '// host-protocol-testing is forbidden')).toEqual([])
})
it('scans Astro frontmatter and script blocks but not template text', () => {
  const file = join(root, 'apps/site/src/example.astro')
  for (const text of [
    "---\nimport { createFakeHost } from '@phosphor/shared/host-protocol-testing'\n---\n<p>Page</p>",
    "<script lang='ts'>import type { Kit } from '@phosphor/shared/host-protocol-testing'</script>",
    "---\r\nconst title = 'Page'\r\n---\r\n<script>const kit = import('@phosphor/shared/host-protocol-testing')</script>",
    "<script>const ok = true</script><script>const kit = require('@phosphor/shared/host-protocol-testing')</script>",
    // A quoted attribute holding `>` must not end the opening tag early.
    `<script type="module" data-note=">">import { createFakeHost } from '@phosphor/shared/host-protocol-testing'</script>`,
    "<script data-note='a>b'>import '@phosphor/shared/host-protocol-testing'</script>",
  ])
    expect(forbiddenImports(file, text)).toHaveLength(1)
  expect(
    forbiddenImports(
      file,
      "---\nimport Layout from './Layout.astro'\n---\n<p>host-protocol-testing</p><script>// host-protocol-testing\nconst ok = true</script>",
    ),
  ).toEqual([])
  expect(sources(join(root, 'apps/site/src')).some((file) => file.endsWith('.astro'))).toBe(true)
})
function dependencyViolations(entries: string[]): string[] {
  const visited = new Set<string>()
  const violations: string[] = []
  function check(file: string) {
    if (visited.has(file)) return
    visited.add(file)
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
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
        ) {
          if (!node.text.startsWith('.')) violations.push(`${file}: ${node.text}`)
          else {
            const resolved = ts.resolveModuleName(
              node.text,
              file,
              {
                moduleResolution: ts.ModuleResolutionKind.Bundler,
              },
              ts.sys,
            ).resolvedModule
            if (!resolved) violations.push(`${file}: unresolved ${node.text}`)
            else check(resolved.resolvedFileName)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  entries.forEach(check)
  return violations
}

it('keeps the contract parser dependency graph free of Node and DOM imports', () => {
  expect(
    dependencyViolations([join(sourceRoot, 'host-protocol.ts'), join(sourceRoot, 'host-grant.ts')]),
  ).toEqual([])
})

function withSources(files: Record<string, string>, check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'host-kit-boundary-'))
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

it('finds production violations after test relocation and domain splitting', () => {
  withSources(
    {
      'libs/shared/package.json': JSON.stringify({ name: '@phosphor/shared' }),
      'libs/shared/test/nested/boundary.test.ts': '',
      'libs/shared/src/host-protocol-testing/index.ts': "export * from './private/fake'",
      'libs/shared/src/host-protocol-testing/private/fake.ts': "import 'vitest'",
      'libs/shared/src/host-protocol/domain/private.ts':
        "export * from '../../host-protocol-testing/private/fake'",
      'apps/host/src/domain/private.ts':
        "type Kit = import('@phosphor/shared/host-protocol-testing').FrameSocket",
      'apps/host/src/domain/safe.ts': "export const note = 'host-protocol-testing'",
      'apps/host/src/domain/ignored.test.ts': "import '@phosphor/shared/host-protocol-testing'",
    },
    (directory) => {
      const source = sharedSourceRoot(join(directory, 'libs/shared/test/nested'))
      expect(source).toBe(join(directory, 'libs/shared/src'))
      expect(productionViolations(directory, join(source, 'host-protocol-testing')).sort()).toEqual(
        [
          'apps/host/src/domain/private.ts: @phosphor/shared/host-protocol-testing',
          'libs/shared/src/host-protocol/domain/private.ts: ../../host-protocol-testing/private/fake',
        ],
      )
    },
  )
})

it.each([
  "import { value } from './domain/private'",
  "import type { Value } from './domain/private'",
  "export * from './domain/private'",
  "export type { Value } from './domain/private'",
  "const module = import('./domain/private')",
  "type Module = import('./domain/private').Value",
  "const module = require('./domain/private')",
  "import module = require('./domain/private')",
])('traverses nested parser dependencies through %s', (entry) => {
  withSources(
    {
      'entry.ts': entry,
      'domain/private.ts': "export * from './deep/forbidden'",
      'domain/deep/forbidden.ts': "import type { Stats } from 'node:fs'",
    },
    (directory) => {
      expect(dependencyViolations([join(directory, 'entry.ts')])).toEqual([
        `${join(directory, 'domain/deep/forbidden.ts')}: node:fs`,
      ])
    },
  )
})

it('traverses private parser modules once and permits relative cycles', () => {
  withSources(
    {
      'entry.ts': "export * from './domain/private'",
      'domain/private.ts': "export * from '../entry'; export type Value = number",
    },
    (directory) => {
      expect(dependencyViolations([join(directory, 'entry.ts')])).toEqual([])
    },
  )
})
