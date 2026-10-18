import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { loadProjectRoots, owningProject, repoPath } from '../select-unit-tests.mjs'
import { validateRelocationMap } from '../test-inventory.mjs'
import { assertContained, findCollisions, relocationTarget, SHIPPING_FIXTURE } from './map.mjs'
import { compareCodeUnits, newSpecifier, pathReports, resolveImport } from './references.mjs'
import { budgetRenames } from './budgets.mjs'

/**
 * @typedef {{from:string, to:string, kind:string, hash:string}} Move
 * @typedef {{start:number, end:number, from:string, to:string}} Replacement
 * @typedef {{file:string, to:string, hash:string, edits:Replacement[]}} ImporterEdit
 * @typedef {{file:string, line:number, reason:string, text:string}} Report
 * @typedef {{version:1, moves:Move[], importerEdits:ImporterEdit[], reports:Report[],
 *   budgetRenames:Record<string,Record<string,string>>,
 *   collisions:{from:string, to:string, existing:string}[], totals:Record<string,number>}} Plan
 */
const code = /\.[cm]?[jt]sx?$/
const fixture = /(?:^|\/)(?:__fixtures__|__tests__|test-support|test-helpers|test-utils)(?:\/|\.)/
const publicSupport = (file) => file.startsWith('libs/shared/src/host-protocol-testing/')
const e2e = (file) => /(?:^|\/)e2e\//.test(file)
const reportOnlyConsumer = (file) =>
  e2e(file) || file.startsWith('apps/site/') || file.startsWith('supabase/')
const hash = (content) => createHash('sha256').update(content).digest('hex')
const read = (root, file) => readFileSync(`${root}/${file}`)

function importArgument(node, source) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal
  if (ts.isExternalModuleReference(node)) return node.expression
  if (
    ts.isCallExpression(node) &&
    /^(?:vi|vitest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)$/.test(
      node.expression.getText(source),
    )
  ) {
    const argument = node.arguments[0]
    // vi.mock(import('./module')) is covered by its inner import expression.
    return argument && ts.isStringLiteralLike(argument) ? argument : undefined
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      node.expression.getText(source) === 'require')
  )
    return node.arguments[0]
}

function inspect(file, content, files) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
  const imports = []
  const strings = []
  const math = []
  const visit = (node) => {
    const importNode = importArgument(node, source)
    if (importNode && ts.isStringLiteralLike(importNode)) {
      imports.push({
        specifier: importNode.text,
        raw: content.slice(importNode.getStart(source) + 1, importNode.getEnd() - 1),
        quote: content[importNode.getStart(source)],
        target: resolveImport(file, importNode.text, files),
        start: importNode.getStart(source) + 1,
        end: importNode.getEnd() - 1,
        line: source.getLineAndCharacterOfPosition(importNode.getStart(source)).line + 1,
      })
    }
    if (ts.isStringLiteralLike(node))
      strings.push({
        text: node.text,
        start: node.getStart(source) + 1,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      })
    if (
      ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        /^(?:join|resolve|URL|fileURLToPath|dirname|(?:posix|path)\.(?:join|resolve|dirname))$/.test(
          node.expression.getText(source),
        ) &&
        /(?:import\.meta\.(?:dirname|url)|__dirname)/.test(node.getText(source))) ||
      (importNode && !ts.isStringLiteralLike(importNode))
    )
      math.push({
        text: node.getText(source),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imports, strings, math }
}

function shippingDependencies(records, tests) {
  const shipping = new Set()
  const visit = (file) => {
    if (shipping.has(file)) return
    shipping.add(file)
    for (const entry of records.get(file)?.imports ?? []) if (entry.target) visit(entry.target)
  }
  for (const file of records.keys())
    if (!tests.has(file) && !fixture.test(file) && !e2e(file) && !file.includes('/test/'))
      visit(file)
  return shipping
}

function makeMoves(root, files, tests, records, contents) {
  const shipping = shippingDependencies(records, tests)
  return files.flatMap((from) => {
    const isFixture = fixture.test(from) && !publicSupport(from)
    if (!tests.has(from) && from !== SHIPPING_FIXTURE && !(isFixture && !shipping.has(from)))
      return []
    const to = relocationTarget(from)
    if (from === to) return []
    assertContained(root, from)
    assertContained(root, to)
    return [
      {
        from,
        to,
        kind: tests.has(from)
          ? 'test'
          : from === SHIPPING_FIXTURE
            ? 'shipping-fixture'
            : 'test-support',
        hash: hash(contents.get(from)),
      },
    ]
  })
}

function importerEdits(records, moves, reports, contents) {
  const destinations = new Map(moves.map(({ from, to }) => [from, to]))
  const result = []
  for (const [file, record] of records) {
    const to = destinations.get(file) ?? file
    const edits = []
    for (const entry of record.imports) {
      const target = destinations.get(entry.target) ?? entry.target
      if (!target) {
        if (to !== file && /^(?:\.|@\/|@shared\/|@phosphor\/)/.test(entry.specifier))
          reports.push({
            file,
            line: entry.line,
            reason: 'unresolved-import',
            text: entry.specifier,
          })
        continue
      }
      if (to === file && target === entry.target) continue
      const replacement = newSpecifier(to, target, entry.specifier)
      if (replacement === entry.specifier) continue
      if (
        reportOnlyConsumer(file) ||
        (file === 'apps/desktop/src/dev/mockPhosphor.ts' && entry.target === SHIPPING_FIXTURE)
      ) {
        reports.push({ file, line: entry.line, reason: 'external-consumer', text: entry.specifier })
        continue
      }
      edits.push({
        start: entry.start,
        end: entry.end,
        from: entry.raw,
        to: replacement
          .replaceAll('\\', '\\\\')
          .replaceAll(entry.quote, `\\${entry.quote}`)
          .replaceAll('${', '\\${'),
      })
    }
    if (edits.length) result.push({ file, to, hash: hash(contents.get(file)), edits })
  }
  return result
}

/**
 * Dry-run only: inputs come from git and Vitest, never inferred from test suffixes.
 * @param {{root?:string, files:string[], tests:string[],
 *   projects?:{name:string, roots:string[]}[]}} options
 * @returns {Plan}
 */
export function buildPlan({
  root = process.cwd(),
  files,
  tests,
  projects = loadProjectRoots(root),
}) {
  if (!tests.length) throw new Error('Empty Vitest inventory')
  const paths = [...new Set(files.map(repoPath))].sort()
  const tracked = new Set(paths)
  const testSet = new Set(tests.map(repoPath))
  for (const test of testSet) if (!tracked.has(test)) throw new Error(`Untracked test: ${test}`)
  const contents = new Map()
  const records = new Map()
  for (const file of paths) {
    assertContained(root, file)
    const content = read(root, file)
    contents.set(file, content)
    if (code.test(file)) records.set(file, inspect(file, content.toString('utf8'), tracked))
  }
  const moves = makeMoves(root, paths, testSet, records, contents)
  const collisions = findCollisions(paths, moves)
  const reports = pathReports(paths, contents, records, moves)
  const edits = importerEdits(records, moves, reports, contents)
  const plan = {
    version: 1,
    moves,
    importerEdits: edits,
    reports: reports.sort(
      (a, b) =>
        compareCodeUnits(a.file, b.file) || a.line - b.line || compareCodeUnits(a.reason, b.reason),
    ),
    budgetRenames: budgetRenames(contents, moves),
    collisions,
    totals: {},
  }
  for (const move of moves) {
    const { project } = owningProject(move.from, projects)
    plan.totals[project] = (plan.totals[project] ?? 0) + 1
  }
  if (!collisions.length) validateRelocationMap(plan)
  return plan
}

/**
 * Hash preconditions only; this does not apply or verify a relocation.
 * @param {string} root
 * @param {Plan} plan
 */
export function validatePlanInputs(root, plan) {
  for (const entry of [...plan.moves, ...plan.importerEdits]) {
    const file = entry.from ?? entry.file
    assertContained(root, file)
    if (hash(read(root, file)) !== entry.hash) throw new Error(`Stale input hash: ${file}`)
  }
  return true
}
