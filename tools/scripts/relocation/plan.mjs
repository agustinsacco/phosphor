import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import ts from 'typescript'
import { loadProjectRoots, owningProject, repoPath } from '../select-unit-tests.mjs'
import { validateRelocationMap } from '../test-inventory.mjs'
import { assertContained, findCollisions, relocationTarget, SHIPPING_FIXTURE } from './map.mjs'

/**
 * @typedef {{from:string, to:string, kind:string, hash:string}} Move
 * @typedef {{start:number, end:number, from:string, to:string}} Replacement
 * @typedef {{file:string, to:string, hash:string, edits:Replacement[]}} ImporterEdit
 * @typedef {{file:string, line:number, reason:string, text:string}} Report
 * @typedef {{version:1, moves:Move[], importerEdits:ImporterEdit[], reports:Report[],
 *   collisions:{from:string, to:string, existing:string}[], totals:Record<string,number>}} Plan
 */
const code = /\.[cm]?[jt]sx?$/
const fixture = /(?:^|\/)(?:__fixtures__|__tests__|test-support|test-helpers|test-utils)(?:\/|\.)/
const publicSupport = (file) => file.startsWith('libs/shared/src/host-protocol-testing/')
const e2e = (file) => /(?:^|\/)e2e\//.test(file)
const reportOnlyConsumer = (file) =>
  e2e(file) || file.startsWith('apps/site/') || file.startsWith('supabase/')
const aliases = [
  ['@phosphor/session-runtime/', 'libs/session-runtime/src/'],
  ['@phosphor/pi-extensions/', 'libs/pi-extensions/pi-ext/'],
  ['@phosphor/shared/', 'libs/shared/src/'],
  ['@shared/', 'libs/shared/src/'],
  ['@/', 'apps/desktop/src/'],
]
const hash = (content) => createHash('sha256').update(content).digest('hex')
const read = (root, file) => readFileSync(`${root}/${file}`)

function resolveImport(file, specifier, files) {
  const bare = specifier.split(/[?#]/)[0]
  const alias = aliases.find(([prefix]) => bare.startsWith(prefix))
  const path = alias
    ? alias[1] + bare.slice(alias[0].length)
    : bare.startsWith('.')
      ? posix.normalize(posix.join(posix.dirname(file), bare))
      : undefined
  if (!path) return undefined
  const base = path.replace(/\.[cm]?jsx?$/, '')
  return [
    path,
    ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].flatMap((extension) => [
      base + extension,
      `${path}/index${extension}`,
    ]),
  ].find((candidate) => files.has(candidate))
}

function importArgument(node, source) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal
  if (ts.isExternalModuleReference(node)) return node.expression
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

function newSpecifier(file, target, original) {
  const suffix = original.match(/[?#].*$/)?.[0] ?? ''
  const bare = original.slice(0, original.length - suffix.length)
  const alias = aliases.find(([prefix, root]) => bare.startsWith(prefix) && target.startsWith(root))
  let relative = alias
    ? alias[0] + target.slice(alias[1].length)
    : posix.relative(posix.dirname(file), target)
  if (!alias && !relative.startsWith('.')) relative = `./${relative}`
  if (!posix.extname(bare)) relative = relative.replace(/\.[cm]?[jt]sx?$/, '')
  else if (/\.[cm]?js$/.test(bare)) relative = relative.replace(/\.[cm]?tsx?$/, posix.extname(bare))
  if (relative.endsWith('/index') && !bare.endsWith('/index')) relative = relative.slice(0, -6)
  return relative + suffix
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
      if (
        reportOnlyConsumer(file) ||
        (file === 'apps/desktop/src/dev/mockPhosphor.ts' && entry.target === SHIPPING_FIXTURE)
      ) {
        reports.push({ file, line: entry.line, reason: 'external-consumer', text: entry.specifier })
        continue
      }
      const replacement = newSpecifier(to, target, entry.specifier)
      if (replacement !== entry.specifier)
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

function pathReports(files, contents, records, moves) {
  const reports = []
  const moved = new Set(moves.map(({ from }) => from))
  const tracked = new Set(files)
  const affectedPath = (file, text) => {
    const resolved = resolveImport(file, text, tracked)
    if (resolved && (moved.has(file) || moved.has(resolved))) return true
    const bare = text.split(/[?#]/)[0]
    if (!bare) return false
    const candidates = [bare, posix.normalize(posix.join(posix.dirname(file), bare))]
    return candidates.some((path) =>
      [...moved].some((from) => from === path || from.startsWith(`${path}/`)),
    )
  }
  for (const file of files) {
    // Documentation is not executable path input. Other tracked config/scripts are inspected.
    if (/\.(?:md|jsonl|svg|png|webp|lock)$/.test(file)) continue
    const record = records.get(file)
    if (record) {
      const positions = new Set(record.imports.map(({ start }) => start))
      for (const entry of record.strings) {
        if (positions.has(entry.start)) continue
        if (
          entry.text.includes('__fixtures__') ||
          /(?:!.*|adhoc-sign-mac)\.test\.ts/.test(entry.text) ||
          affectedPath(file, entry.text) ||
          [...moved].some((from) => entry.text.includes(from))
        )
          reports.push({ file, line: entry.line, reason: 'string-path', text: entry.text })
      }
      if (moved.has(file))
        for (const entry of record.math) reports.push({ file, ...entry, reason: 'path-math' })
    } else {
      contents
        .get(file)
        .toString('utf8')
        .split('\n')
        .forEach((text, index) => {
          if ([...moved].some((from) => text.includes(from)) || /!.*\.test\.ts/.test(text))
            reports.push({ file, line: index + 1, reason: 'config-path', text: text.trim() })
        })
    }
  }
  return reports
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
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason),
    ),
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
