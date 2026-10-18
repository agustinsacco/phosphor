/**
 * CLI: collect|run --out inventory.json [--map moves.json] [explicit test files...];
 * compare --before old.json --after new.json [--map moves.json] [--allow-platform-mismatch].
 * Relocation schema: {version:1, moves:[{from:repoPath,to:repoPath,...}]}; unknown fields
 * are ignored. No map means identity mapping. Identities use the OLD source path,
 * owning project, fullName and occurrence ordinal, never Vitest's numeric task ids.
 * Vitest 4.1.10 list omits skipped/todo cases. Collection counts are NOT execution
 * counts: run retains every assertion (including skipped/pending/todo identities).
 * Only like kinds and matching OS/Node major are comparable by default.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProjectRoots, owningProject, repoPath } from './select-unit-tests.mjs'

/**
 * @typedef {'passed' | 'failed' | 'skipped' | 'todo'} CaseStatus
 * @typedef {{ project: string, path: string, fullName: string, ordinal: number,
 *   file: string, status?: CaseStatus }} InventoryCase
 * @typedef {{ total: number, passed: number, skipped: number, todo: number,
 *   failed: number }} ExecutionCounts
 * @typedef {{ version: 1, kind: 'collection' | 'execution',
 *   platform: { os: string, nodeMajor: number },
 *   counts: { collected: number, executed: ExecutionCounts | null },
 *   cases: InventoryCase[] }} Inventory
 */

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const statuses = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'skipped',
  todo: 'todo',
}
const key = (entry) => JSON.stringify([entry.project, entry.path, entry.fullName, entry.ordinal])

export function validateRelocationMap(map) {
  if (map === undefined) return []
  if (!map || map.version !== 1 || !Array.isArray(map.moves))
    throw new Error('Invalid relocation manifest version/moves')
  const froms = new Set()
  const tos = new Set()
  const moves = map.moves.map((move) => {
    const from = repoPath(move?.from)
    const to = repoPath(move?.to)
    if (froms.has(from) || tos.has(to)) throw new Error('Duplicate relocation from/to')
    froms.add(from)
    tos.add(to)
    return { from, to }
  })
  if ([...froms].some((from) => tos.has(from)))
    throw new Error('Overlapping relocation sources and destinations')
  return moves
}

// Retain the distinguishing root segments when a project owns multiple trees.
function identityRoot(roots) {
  const parts = roots[0].split('/')
  while (parts.length && !roots.every((root) => `${root}/`.startsWith(`${parts.join('/')}/`)))
    parts.pop()
  return parts.join('/')
}

function canonicalFile(file, moves) {
  return moves.find((move) => move.to === file)?.from ?? file
}
function absoluteToRepo(file, root) {
  if (typeof file !== 'string' || !isAbsolute(file))
    throw new Error('Expected absolute Vitest file path')
  return repoPath(relative(root, file).replaceAll('\\', '/'))
}
function countsFor(kind, cases) {
  if (kind === 'collection') return { collected: cases.length, executed: null }
  const executed = { total: cases.length, passed: 0, skipped: 0, todo: 0, failed: 0 }
  for (const entry of cases) executed[entry.status]++
  return { collected: 0, executed }
}
/** @returns {Inventory} */
function normalize(kind, rawCases, options) {
  const root = options.root ?? process.cwd()
  const projects = options.projects ?? loadProjectRoots(root)
  const moves = validateRelocationMap(options.map)
  const occurrences = new Map()
  // Vitest's include globs, not directory names, define the fixture boundary.
  const cases = rawCases.map((entry) => {
    const file = canonicalFile(entry.file, moves)
    const owner = owningProject(file, projects)
    const root = identityRoot(projects.find((project) => project.name === owner.project).roots)
    const identity = {
      project: owner.project,
      path: root ? file.slice(root.length + 1) : file,
      fullName: entry.fullName,
    }
    const signature = JSON.stringify(identity)
    const ordinal = (occurrences.get(signature) ?? 0) + 1
    occurrences.set(signature, ordinal)
    return {
      ...identity,
      ordinal,
      file,
      ...(kind === 'execution' ? { status: entry.status } : {}),
    }
  })
  if (!cases.length) throw new Error('Empty test inventory')
  return {
    version: 1,
    kind,
    platform: { os: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]) },
    counts: countsFor(kind, cases),
    cases,
  }
}

/** @returns {Inventory} */
export function normalizeCollection(report, options = {}) {
  if (!Array.isArray(report)) throw new Error('Invalid Vitest list JSON')
  const rawCases = report.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !entry.name)
      throw new Error('Invalid collection name')
    return { file: absoluteToRepo(entry.file, options.root ?? process.cwd()), fullName: entry.name }
  })
  return normalize('collection', rawCases, options)
}

/** @returns {Inventory} */
export function normalizeExecution(report, options = {}) {
  if (!report || !Array.isArray(report.testResults))
    throw new Error('Invalid Vitest execution JSON')
  const rawCases = report.testResults.flatMap((suite) => {
    const file = absoluteToRepo(suite.name, options.root ?? process.cwd())
    if (!Array.isArray(suite.assertionResults)) throw new Error('Invalid assertionResults')
    if (
      suite.status === 'failed' &&
      !suite.assertionResults.some((test) => test.status === 'failed')
    )
      throw new Error(`Suite failed without assertions: ${file}: ${suite.message ?? ''}`)
    return suite.assertionResults.map((test) => {
      if (
        !test ||
        typeof test.fullName !== 'string' ||
        !test.fullName ||
        !Object.hasOwn(statuses, test.status)
      )
        throw new Error('Invalid assertion name/status')
      if (
        !Array.isArray(test.ancestorTitles) ||
        test.ancestorTitles.some((title) => typeof title !== 'string') ||
        typeof test.title !== 'string'
      )
        throw new Error('Invalid assertion titles')
      // JSON reporter uses spaces; list uses " > ". Build the same unambiguous
      // display name from the reporter's title segments rather than replacing text.
      return {
        file,
        fullName: [...test.ancestorTitles, test.title].join(' > '),
        status: statuses[test.status],
      }
    })
  })
  return normalize('execution', rawCases, options)
}

export function validateInventory(inventory) {
  if (
    !inventory ||
    inventory.version !== 1 ||
    !['collection', 'execution'].includes(inventory.kind) ||
    !inventory.platform ||
    typeof inventory.platform.os !== 'string' ||
    !Number.isInteger(inventory.platform.nodeMajor) ||
    !Array.isArray(inventory.cases) ||
    !inventory.cases.length
  )
    throw new Error('Invalid normalized inventory')
  const seen = new Set()
  for (const entry of inventory.cases) {
    if (
      !entry ||
      typeof entry.project !== 'string' ||
      !entry.project ||
      typeof entry.fullName !== 'string' ||
      !entry.fullName ||
      !Number.isInteger(entry.ordinal) ||
      entry.ordinal < 1
    )
      throw new Error('Invalid inventory identity')
    repoPath(entry.file)
    repoPath(entry.path)
    if (
      inventory.kind === 'execution' &&
      !['passed', 'failed', 'skipped', 'todo'].includes(entry.status)
    )
      throw new Error('Invalid inventory status')
    if (seen.has(key(entry))) throw new Error('Duplicate inventory identity')
    seen.add(key(entry))
  }
  if (
    JSON.stringify(inventory.counts) !== JSON.stringify(countsFor(inventory.kind, inventory.cases))
  )
    throw new Error('Invalid inventory counts')
  return inventory
}

function mappedCases(inventory, moves) {
  const occurrences = new Map()
  return inventory.cases.map((entry) => {
    const file = canonicalFile(entry.file, moves)
    // from/to may move cases between files, but never across owning projects.
    const suffix = entry.file.slice(0, entry.file.length - entry.path.length)
    if (!file.startsWith(suffix))
      throw new Error(`Cross-project relocation requires an owning-project map: ${file}`)
    const mapped = { ...entry, file, path: file.slice(suffix.length) }
    const signature = JSON.stringify([mapped.project, mapped.path, mapped.fullName])
    const ordinal = (occurrences.get(signature) ?? 0) + 1
    occurrences.set(signature, ordinal)
    return { ...mapped, ordinal }
  })
}

export function compareInventories(before, after, options = {}) {
  validateInventory(before)
  validateInventory(after)
  if (before.kind !== after.kind) throw new Error('Inventory kind mismatch')
  if (
    !options.allowPlatformMismatch &&
    (before.platform.os !== after.platform.os ||
      before.platform.nodeMajor !== after.platform.nodeMajor)
  )
    throw new Error('Inventory platform mismatch')
  const moves = validateRelocationMap(options.map)
  const oldCases = new Map(mappedCases(before, moves).map((entry) => [key(entry), entry]))
  const newCases = new Map(mappedCases(after, moves).map((entry) => [key(entry), entry]))
  const missing = [...oldCases].filter(([id]) => !newCases.has(id)).map(([, entry]) => entry)
  const added = [...newCases].filter(([id]) => !oldCases.has(id)).map(([, entry]) => entry)
  const statusChanges = [...oldCases]
    .filter(([id, entry]) => newCases.has(id) && entry.status !== newCases.get(id).status)
    .map(([id, entry]) => ({ before: entry, after: newCases.get(id) }))
  return {
    equal: !missing.length && !added.length && !statusChanges.length,
    missing,
    added,
    statusChanges,
    counts: { before: before.counts, after: after.counts },
  }
}

/** @returns {Inventory} */
export function captureInventory(mode, options = {}) {
  if (!['collect', 'run'].includes(mode)) throw new Error('Expected collect or run')
  const root = options.root ?? process.cwd()
  const temporary = mkdtempSync(join(tmpdir(), 'phosphor-test-inventory-'))
  try {
    const report = join(temporary, 'report.json')
    const args = [
      join(root, 'node_modules/vitest/vitest.mjs'),
      mode === 'collect' ? 'list' : 'run',
      ...(mode === 'collect'
        ? [`--json=${report}`]
        : ['--reporter=json', `--outputFile=${report}`]),
      '--maxWorkers=2',
      ...(options.files ?? []),
    ]
    let failure
    try {
      ;(
        options.invoke ??
        ((command, args) =>
          execFileSync(command, args, { cwd: root, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }))
      )(process.execPath, args)
    } catch (error) {
      failure = error
    }
    // Execution failures still produce a useful inventory with failing cases.
    // Collection failures must not turn partial reports into successful coverage.
    if (failure && mode === 'collect') throw failure
    const inventory = (mode === 'collect' ? normalizeCollection : normalizeExecution)(
      readJson(report),
      options,
    )
    if (failure && !inventory.counts.executed.failed) throw failure
    return inventory
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function main(args) {
  const mode = args.shift()
  const values = {}
  const files = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--allow-platform-mismatch') values.allowPlatformMismatch = true
    else if (['--out', '--before', '--after', '--map'].includes(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith('--'))
        throw new Error(`Missing value: ${arg}`)
      values[arg.slice(2)] = args[++index]
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else files.push(repoPath(arg))
  }
  const map = values.map ? readJson(values.map) : undefined
  if (mode === 'compare') {
    if (!values.before || !values.after) throw new Error('Required: --before and --after')
    const diff = compareInventories(readJson(values.before), readJson(values.after), {
      map,
      allowPlatformMismatch: values.allowPlatformMismatch,
    })
    console.log(JSON.stringify(diff, null, 2))
    if (!diff.equal) process.exitCode = 1
  } else {
    if (!['collect', 'run'].includes(mode) || !values.out)
      throw new Error('Required: collect|run --out inventory.json')
    const inventory = captureInventory(mode, { map, files })
    writeFileSync(values.out, `${JSON.stringify(inventory, null, 2)}\n`)
    console.log(JSON.stringify({ out: values.out, kind: inventory.kind, counts: inventory.counts }))
    if (inventory.counts.executed?.failed) process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
