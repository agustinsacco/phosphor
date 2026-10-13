import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
const kit = resolve(import.meta.dirname)
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
function forbiddenImports(file: string, text: string): string[] {
  if (file.endsWith('.astro')) {
    const frontmatter = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
    const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].flatMap(
      (match) => (match[1] === undefined ? [] : [match[1]]),
    )
    return [...(frontmatter === undefined ? [] : [frontmatter]), ...scripts].flatMap((source) =>
      forbiddenImports(file + '.ts', source),
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
          target === kit ||
          target.startsWith(kit + '/')
        )
          imports.push(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return imports
}

it('keeps host-protocol-testing out of every production source in apps and libs', () => {
  const violations = ['apps', 'libs']
    .flatMap((directory) => sources(join(root, directory)))
    .filter((file) => !file.startsWith(kit + '/'))
    .flatMap((file) =>
      forbiddenImports(file, readFileSync(file, 'utf8')).map(
        (target) => `${relative(root, file)}: ${target}`,
      ),
    )
  expect(violations).toEqual([])
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
it('keeps the contract parser dependency graph free of Node and DOM imports', () => {
  const visited = new Set<string>()
  function check(file: string) {
    if (visited.has(file)) return
    visited.add(file)
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
      const name = node.moduleSpecifier.text
      expect(name.startsWith('.'), `${relative(root, file)}: ${name}`).toBe(true)
      check(resolve(dirname(file), name + '.ts'))
    }
  }
  check(resolve(kit, '../host-protocol.ts'))
  check(resolve(kit, '../host-grant.ts'))
})
