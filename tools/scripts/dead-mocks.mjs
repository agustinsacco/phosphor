// Flags vi.mock / vi.doMock calls whose target module the test no longer loads.
// A dead mock passes silently: the code under test now imports the real module
// from somewhere else, so the test quietly exercises code it meant to replace.
// Usage: node tools/scripts/dead-mocks.mjs (CI runs it; any finding fails).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { compareCodeUnits, resolveImport } from './relocation/references.mjs'

const CODE = /\.[cm]?[jt]sx?$/
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const MOCK = /^(?:vi|vitest)\.(?:mock|doMock)$/

function literal(node) {
  if (!node) return undefined
  if (ts.isStringLiteralLike(node)) return node.text
  // vi.mock(import('./module'), ...)
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    return literal(node.arguments[0])
  return undefined
}

function isTypeOnly(node) {
  if (ts.isImportDeclaration(node)) return !!node.importClause?.isTypeOnly
  if (ts.isExportDeclaration(node)) return node.isTypeOnly
  return false
}

/** Runtime module edges and vi.mock targets of one source file. */
export function scanSource(file, content) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
  const imports = []
  const mocks = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !isTypeOnly(node)) {
      const specifier = literal(node.moduleSpecifier)
      if (specifier) imports.push(specifier)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      const specifier = literal(node.arguments[0])
      if (specifier && MOCK.test(callee)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        mocks.push({ specifier, line })
        // The factory runs only when something loads the target: do not walk into it.
        return
      }
      if (
        specifier &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || callee === 'require')
      )
        imports.push(specifier)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imports, mocks }
}

/**
 * @param {string[]} paths repository-relative paths of tracked files
 * @param {(file: string) => string} read
 * @returns {{file:string, line:number, specifier:string, target:string}[]}
 */
export function findDeadMocks(paths, read) {
  const files = new Set(paths)
  const scans = new Map()
  const scan = (file) => {
    if (!scans.has(file)) scans.set(file, scanSource(file, read(file)))
    return scans.get(file)
  }
  const edges = (file) =>
    scan(file)
      .imports.map((specifier) => resolveImport(file, specifier, files))
      .filter((target) => target && CODE.test(target))
  const dead = []
  for (const test of paths.filter((file) => TEST.test(file)).sort(compareCodeUnits)) {
    const mocks = scan(test).mocks
    if (!mocks.length) continue
    const reached = new Set()
    const stack = edges(test)
    while (stack.length) {
      const next = stack.pop()
      if (reached.has(next)) continue
      reached.add(next)
      stack.push(...edges(next))
    }
    for (const { specifier, line } of mocks) {
      // Packages and builtins resolve outside the workspace; they cannot be judged here.
      const target = resolveImport(test, specifier, files)
      if (target && !reached.has(target)) dead.push({ file: test, line, specifier, target })
    }
  }
  return dead
}

function main() {
  const root = resolve(import.meta.dirname, '../..')
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => CODE.test(file) && !file.startsWith('apps/site/'))
  const dead = findDeadMocks(paths, (file) => readFileSync(resolve(root, file), 'utf8'))
  for (const entry of dead)
    console.error(
      `${entry.file}:${entry.line}: vi.mock('${entry.specifier}') is dead: nothing the test loads imports ${entry.target}. Mock the module the code imports now, or delete the mock.`,
    )
  console.log(`Dead mocks: ${dead.length ? `FAIL (${dead.length})` : 'PASS'}`)
  return dead.length ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main()
