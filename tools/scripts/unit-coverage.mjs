/**
 * Compare owned statement coverage at two committed refs (before characterization / final).
 * --unit unit.json --before ref --after ref [--map moves.json] test-files...
 * Unit owns globs select tracked JS/TS sources, never just imported files. The optional
 * relocation manifest is FD-05's {version:1,moves:[{from,to,kind?}]} format.
 * Tests and declarations are excluded; generated sources are NOT silently excluded.
 * Both detached snapshots use this installation, Node executable, OS and command.
 * Coverage is additional evidence, not proof of unchanged semantics.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadProjectRoots,
  owningProject,
  repoPath,
  validateUnitSpec,
} from './select-unit-tests.mjs'
import { validateRelocationMap } from './test-inventory.mjs'

/**
 * @typedef {{file:string, covered:number, total:number}} FileCoverage
 * @typedef {{covered:number, total:number, files:FileCoverage[]}} Aggregate
 * @typedef {{version:number, moves:{from:string,to:string,kind?:string}[]}} MoveMap
 * @typedef {{owns:string[], characterize_first?:{test:string}[], new_tests?:{test:string}[],
 * existing_tests?:string[], kind?:string}} Unit
 */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const git = (root, ...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const tracked = (root) => git(root, 'ls-files', '-z').split('\0').filter(Boolean).map(repoPath)
const source = (file) =>
  /\.[cm]?[jt]sx?$/.test(file) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(file)
const canonical = (file, moves) => moves.find((move) => move.to === file)?.from ?? file

/** @param {Unit} unit @param {string} root @param {MoveMap | undefined} map @returns {string[]} */
export function coverageScope(unit, root, map = undefined) {
  const selection = validateUnitSpec(unit)
  const moves = validateRelocationMap(map)
  const patterns = unit.owns.map((entry) => entry.replace(/\s*\(.*\)\s*$/, '').trim())
  const owned = tracked(root).filter(
    (file) =>
      patterns.some((pattern) => matchesGlob(file, pattern)) ||
      moves.some((move) => move.from === file || move.to === file),
  )
  for (const file of owned)
    if (/\.(?:sh|ps1|py)$/.test(file)) throw new Error(`Unsupported executable coverage: ${file}`)
  const files = owned.filter(source)
  if (!files.length) throw new Error('Empty owned executable source scope')
  const projects = loadProjectRoots(root)
  for (const file of files) {
    // Repository-level build/config entries have no project root.
    if (file.includes('/')) owningProject(file, projects)
  }
  if (!selection.tests.length) throw new Error('Explicit tests required')
  return files.sort()
}

/**
 * @param {unknown} report @param {string[]} files @param {string} root
 * @param {MoveMap | undefined} map @returns {Aggregate}
 */
export function aggregateCoverage(report, files, root, map = undefined) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Invalid coverage report')
  if (!files.length || new Set(files).size !== files.length)
    throw new Error('Empty/duplicate scope')
  const moves = validateRelocationMap(map)
  const entries = new Map()
  for (const [path, entry] of Object.entries(report)) {
    if (!isAbsolute(path)) throw new Error('Expected absolute coverage path')
    const file = repoPath(relative(root, path).replaceAll('\\', '/'))
    if (entries.has(file)) throw new Error(`Duplicate coverage report: ${file}`)
    entries.set(file, entry)
  }
  const measured = files.map((path) => {
    repoPath(path)
    const entry = entries.get(path)
    if (!entry) throw new Error(`Missing coverage report: ${path}`)
    if (
      !entry.s ||
      typeof entry.s !== 'object' ||
      Array.isArray(entry.s) ||
      !entry.statementMap ||
      typeof entry.statementMap !== 'object' ||
      Array.isArray(entry.statementMap)
    )
      throw new Error(`Invalid statement report: ${path}`)
    const ids = Object.keys(entry.statementMap)
    if (
      ids.length !== Object.keys(entry.s).length ||
      ids.some(
        (id) =>
          !Object.hasOwn(entry.s, id) || !Number.isSafeInteger(entry.s[id]) || entry.s[id] < 0,
      )
    )
      throw new Error(`Invalid statement counts: ${path}`)
    return {
      file: canonical(path, moves),
      covered: ids.filter((id) => entry.s[id] > 0).length,
      total: ids.length,
    }
  })
  if (new Set(measured.map((entry) => entry.file)).size !== measured.length)
    throw new Error('Relocation coverage collision')
  return measured.reduce(
    (sum, entry) => ({
      covered: sum.covered + entry.covered,
      total: sum.total + entry.total,
      files: [...sum.files, entry],
    }),
    { covered: 0, total: 0, files: [] },
  )
}

/** @param {Aggregate} value */
function validateAggregate(value) {
  if (
    !value ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    ![value.covered, value.total].every((count) => Number.isSafeInteger(count) && count >= 0) ||
    value.covered > value.total ||
    new Set(value.files.map((file) => repoPath(file.file))).size !== value.files.length ||
    value.files.some(
      (file) =>
        ![file.covered, file.total].every((count) => Number.isSafeInteger(count) && count >= 0) ||
        file.covered > file.total,
    ) ||
    value.files.reduce((sum, file) => sum + file.covered, 0) !== value.covered ||
    value.files.reduce((sum, file) => sum + file.total, 0) !== value.total
  )
    throw new Error('Invalid aggregate coverage')
}

/** @param {Aggregate} before @param {Aggregate} after */
export function compareCoverage(before, after) {
  validateAggregate(before)
  validateAggregate(after)
  const finalFiles = new Set(after.files.map((entry) => entry.file))
  for (const entry of before.files)
    if (!finalFiles.has(entry.file)) throw new Error(`Lost scope without relocation: ${entry.file}`)
  // Empty statement sets are vacuously covered. BigInt cross-products avoid both
  // percentage rounding and floating-point multiplication errors.
  const numerator = (value) => BigInt(value.total ? value.covered : 1)
  const denominator = (value) => BigInt(value.total || 1)
  return {
    pass: numerator(after) * denominator(before) >= numerator(before) * denominator(after),
    before,
    after,
    denominatorChange: after.total - before.total,
  }
}

function linkDependencies(snapshot, dependencies) {
  const directories = new Set([
    '',
    ...tracked(snapshot)
      .filter((file) => file.endsWith('/package.json'))
      .map(dirname),
  ])
  for (const directory of directories) {
    const installed = join(dependencies, directory, 'node_modules')
    const target = join(snapshot, directory, 'node_modules')
    if (existsSync(installed) && !existsSync(target)) symlinkSync(installed, target, 'junction')
  }
}

function capture(snapshot, files, tests, dependencies, reportDirectory) {
  for (const file of tests)
    if (!existsSync(join(snapshot, file))) throw new Error(`Missing explicit test: ${file}`)
  const args = [
    join(dependencies, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--maxWorkers=2',
    '--coverage.enabled',
    '--coverage.provider=v8',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${reportDirectory}`,
    ...files.map((file) => `--coverage.include=${file}`),
    ...tests,
  ]
  execFileSync(process.execPath, args, {
    cwd: snapshot,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  })
  return aggregateCoverage(readJson(join(reportDirectory, 'coverage-final.json')), files, snapshot)
}

/**
 * @param {{unit:Unit,before:string,after:string,tests:string[],map?:MoveMap,
 * root?:string,dependencies?:string}} options
 */
export function runUnitCoverage(options) {
  const { unit, before, after, map } = options
  validateUnitSpec(unit)
  const moves = validateRelocationMap(map)
  if (!before || !after) throw new Error('Required: before and after refs')
  if (!options.tests?.length) throw new Error('Explicit tests required')
  const tests = [...new Set(options.tests.map(repoPath))].sort()
  const root = resolve(options.root ?? process.cwd())
  const dependencies = resolve(options.dependencies ?? root)
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'phosphor-unit-coverage-')))
  const snapshots = []
  try {
    for (const [name, ref] of [
      ['before', before],
      ['after', after],
    ]) {
      const snapshot = join(temporary, name)
      // Resolve refs before passing them to worktree; reject unknown/option-like input.
      const commit = git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
      git(root, 'worktree', 'add', '--detach', snapshot, commit)
      snapshots.push(snapshot)
      linkDependencies(snapshot, dependencies)
    }
    const [oldRoot, newRoot] = snapshots
    const oldScope = coverageScope(unit, oldRoot, map)
    const newScope = coverageScope(unit, newRoot, map)
    // A source typo must not silently shrink either include set.
    const available = new Set([...oldScope, ...newScope])
    for (const owned of unit.owns.map((entry) => entry.replace(/\s*\(.*\)\s*$/, '').trim()))
      if (source(owned) && !/[*?{}[\]]/.test(owned) && !available.has(owned))
        throw new Error(`Missing owned source: ${owned}`)
    const finalTests = tests.map((test) => moves.find((move) => move.from === test)?.to ?? test)
    const baseline = capture(oldRoot, oldScope, tests, dependencies, join(temporary, 'old-report'))
    const final = capture(
      newRoot,
      newScope,
      finalTests,
      dependencies,
      join(temporary, 'new-report'),
    )
    for (const entry of final.files) entry.file = canonical(entry.file, moves)
    return {
      ...compareCoverage(baseline, final),
      runtime: { os: process.platform, node: process.version, executable: process.execPath },
      command: [
        'vitest',
        'run',
        '--maxWorkers=2',
        '--coverage.enabled',
        '--coverage.provider=v8',
        ...tests,
      ],
    }
  } finally {
    for (const snapshot of snapshots.reverse()) git(root, 'worktree', 'remove', '--force', snapshot)
    rmSync(temporary, { recursive: true, force: true })
  }
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node tools/scripts/unit-coverage.mjs --unit unit.json --before ref --after ref [--map moves.json] explicit.test.ts ...\nCompares aggregate owned-source statements; prints covered/total and denominatorChange. Decreases, lost scope, failed tests and missing reports fail closed. New unimported owned helpers are included. Both refs must contain the same explicit tests; use the before-characterization ref, not a later implementation ref. No global threshold is assumed.',
    )
    return
  }
  const values = {}
  const tests = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (['--unit', '--before', '--after', '--map'].includes(arg)) {
      if (values[arg] || !args[index + 1] || args[index + 1].startsWith('--'))
        throw new Error(`Missing/duplicate value: ${arg}`)
      values[arg] = args[++index]
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else tests.push(repoPath(arg))
  }
  if (!values['--unit'] || !values['--before'] || !values['--after'] || !tests.length)
    throw new Error('Required: --unit unit.json --before ref --after ref explicit.test.ts ...')
  const result = runUnitCoverage({
    unit: readJson(values['--unit']),
    before: values['--before'],
    after: values['--after'],
    tests,
    map: values['--map'] ? readJson(values['--map']) : undefined,
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.pass) process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
