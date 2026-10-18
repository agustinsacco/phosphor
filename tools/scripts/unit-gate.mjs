/**
 * CLI: node tools/scripts/unit-gate.mjs --input gate.json
 * Input is GateOptions below: immutable pre-squash refs, a unit spec, an owner-expanded
 * exact multi-unit manifest, FD-07 aggregate coverage with its refs, and an unused
 * evidencePath. Keep that JSON evidence outside the checkout before squashing.
 * Manifest accepted entries are owner-supplied dependency acceptance, not self-approval.
 * Expand depends_on groups (foundation, reloc, fixes:D1) into unit ids in the manifest.
 * Coverage before-ref: characterizationSha, else the last regression commit, else baseSha;
 * coverage tests must pass at both refs (omit red regressions). Empty side: no comparison.
 * Relocation requires explicit owner approval and ONE exact-content move commit.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repoPath, ROOT_SUITE_INPUTS, validateUnitSpec } from './select-unit-tests.mjs'
import { validateRelocationMap } from './test-inventory.mjs'
import { compareCoverage } from './unit-coverage.mjs'
import {
  blobAt,
  changedPaths,
  commitHistory,
  frozenBlobs,
  gitText,
  immutableCommit,
  withSnapshot,
} from './unit-git.mjs'

/**
 * @typedef {{covered:number,total:number,files:{file:string,covered:number,total:number}[]}} Aggregate
 * @typedef {{id:string,kind:string,owns:string[],depends_on?:string[],
 * characterize_first?:{test:string}[],new_tests?:{test:string}[],existing_tests?:string[]}} Unit
 * @typedef {{version:number,units:{id:string,owns:string[],accepted?:{pass:boolean,finalSha:string}}[]}} Manifest
 * @typedef {{root:string,baseSha:string,finalSha:string,characterizationSha?:string,
 * unit:Unit,manifest:Manifest,evidencePath:string,
 * coverage?:{beforeSha:string,afterSha:string,report:{before:Aggregate,after:Aggregate}},
 * relocation?:{mode:string,approvedBy:string,commitSha:string,
 * map:{version:number,moves:{from:string,to:string}[]}}}} GateOptions
 * @typedef {{sha:string,subject:string,files:string[]}} Commit
 * @typedef {{label:string,sha:string,files:string[],command:string[],status:number|null,
 * passed:number,failed:number,suiteErrors:number,output:string,report:unknown}} Run
 */
const testFile = (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
const sourceFile = (file) =>
  /\.[cm]?[jt]sx?$/.test(file) && !testFile(file) && !/\.d\.[cm]?ts$/.test(file)
const patternsFor = (unit) => unit.owns.map((path) => path.replace(/\s*\(.*\)\s*$/, '').trim())
const rootConfig = (file) =>
  ROOT_SUITE_INPUTS.includes(file) ||
  /^(?:tsconfig[^/]*\.json|(?:vitest|eslint)\.config\.[cm]?[jt]s|apps\/[^/]+\/(?:package(?:-lock)?\.json|tsconfig[^/]*\.json))$/.test(
    file,
  )
const trackedAt = (root, sha) =>
  gitText(root, 'ls-tree', '-r', '--name-only', '-z', sha).split('\0').filter(Boolean)
const regression = (commit, id) => commit.subject.startsWith(`test(${id}): regression `)
const behavior = (unit) => ['fix', 'security', 'perf'].includes(unit.kind)
const testOnly = (options, commit, before) =>
  commit.files.every(
    (file) =>
      testFile(file) ||
      (file.split('/').includes('__fixtures__') &&
        !blobAt(options.root, before, file) &&
        !!blobAt(options.root, commit.sha, file)),
  )
function testPath(file) {
  repoPath(file)
  if (file.split('/').some((part) => part.startsWith('-')))
    throw new Error(`Option-like test path: ${file}`)
  return file
}

function ownership(options, commits) {
  const { manifest, unit, root, baseSha } = options
  if (manifest?.version !== 1 || !Array.isArray(manifest.units))
    throw new Error('Exact ownership manifest required')
  const owners = new Map()
  const ids = new Set()
  for (const entry of manifest.units) {
    if (!entry.id || ids.has(entry.id) || !Array.isArray(entry.owns) || !entry.owns.length)
      throw new Error('Invalid/duplicate manifest unit')
    ids.add(entry.id)
    for (const file of entry.owns) {
      repoPath(file)
      if (/[*?{}[\]]/.test(file))
        throw new Error('Ownership manifest requires exact paths, not globs')
      if (owners.has(file)) throw new Error(`Ownership must be exclusive: ${file}`)
      owners.set(file, entry.id)
    }
  }
  const own = manifest.units.find((entry) => entry.id === unit.id)?.owns
  if (!own) throw new Error('Unit missing from ownership manifest')
  const patterns = patternsFor(unit)
  if (
    own.some((file) => !patterns.some((pattern) => matchesGlob(file, pattern))) ||
    patterns.some((pattern) => !own.some((file) => matchesGlob(file, pattern)))
  )
    throw new Error('Exact manifest does not match declared ownership')
  const paths = new Set(
    [baseSha, ...commits.map((commit) => commit.sha)].flatMap((sha) => trackedAt(root, sha)),
  )
  for (const file of paths)
    if (patterns.some((pattern) => matchesGlob(file, pattern)) && !own.includes(file))
      throw new Error(`Ownership manifest not fully expanded: ${file}`)
  for (const commit of commits)
    for (const file of commit.files)
      if (owners.get(file) !== unit.id) throw new Error(`Path outside exact ownership: ${file}`)
  for (const id of unit.depends_on ?? []) {
    const accepted = manifest.units.find((entry) => entry.id === id)?.accepted
    if (id === unit.id || accepted?.pass !== true) throw new Error(`Unsatisfied dependency: ${id}`)
    immutableCommit(root, accepted.finalSha)
    try {
      gitText(root, 'merge-base', '--is-ancestor', accepted.finalSha, baseSha)
    } catch {
      throw new Error(`Unsatisfied dependency not integrated in base: ${id}`)
    }
  }
}

function relocationFor(options, commits) {
  const relocation = options.relocation
  if (!relocation) return undefined
  if (relocation.mode !== 'relocation' || !relocation.approvedBy?.trim())
    throw new Error('Relocation requires explicit mode and owner approval')
  immutableCommit(options.root, relocation.commitSha)
  const index = commits.findIndex((commit) => commit.sha === relocation.commitSha)
  const moves = validateRelocationMap(relocation.map)
  if (index < 0 || !moves.length)
    throw new Error('Relocation must name one unit commit and nonempty map')
  const before = index ? commits[index - 1].sha : options.baseSha
  for (const move of moves) {
    const original = blobAt(options.root, before, move.from)
    const moved = blobAt(options.root, relocation.commitSha, move.to)
    if (
      !original ||
      moved?.blob !== original.blob ||
      moved?.mode !== original.mode ||
      blobAt(options.root, relocation.commitSha, move.from) ||
      blobAt(options.root, before, move.to)
    )
      throw new Error(`Non-mechanical relocation: ${move.from} -> ${move.to}`)
  }
  return { commitSha: relocation.commitSha, moves }
}

function characterize(options, commits) {
  const { root, baseSha } = options
  const files = options.unit.characterize_first?.map((entry) => testPath(entry.test)) ?? []
  if (!files.length) {
    if (options.characterizationSha) throw new Error('Unspecified characterization SHA')
    if (!['fix', 'security', 'perf', 'tooling', 'docs'].includes(options.unit.kind))
      throw new Error('Specified public-entry characterization tests required')
    return []
  }
  immutableCommit(options.root, options.characterizationSha)
  const first = commits[0]
  if (
    first.sha !== options.characterizationSha ||
    !(
      first.subject.startsWith(`test(${options.unit.id}): characterize `) ||
      (behavior(options.unit) && regression(first, options.unit.id))
    )
  )
    throw new Error('Characterization must be the first commit')
  if (!testOnly(options, first, options.baseSha))
    throw new Error('Characterization commit must be test-only')
  if (files.some((file) => !first.files.includes(file)))
    throw new Error('Missing specified characterization tests')
  for (const file of first.files) {
    if (!blobAt(options.root, first.sha, file))
      throw new Error('Characterization must add tests, not delete them')
    const stat = gitText(root, 'diff', '--numstat', '-z', baseSha, first.sha, '--', file)
    const [added, removed] = stat.split('\t')
    if (!(Number(added) > 0) || Number(removed) !== 0)
      throw new Error('Characterization must only add tests to unchanged implementation')
  }
  return first.files
}

function coverageEvidence(options, relocation, regressions) {
  if (options.unit.kind === 'docs') return
  const coverage = options.coverage
  const before = options.characterizationSha ?? regressions.at(-1)?.sha ?? options.baseSha
  const patterns = patternsFor(options.unit)
  const scopes = [before, options.finalSha].map((sha) =>
    trackedAt(options.root, sha)
      .filter((file) => sourceFile(file) && patterns.some((pattern) => matchesGlob(file, pattern)))
      .map((file) => relocation?.moves.find((move) => move.to === file)?.from ?? file)
      .sort(),
  )
  if (!scopes[0]?.length || !scopes[1]?.length) {
    if (coverage !== undefined) throw new Error('Coverage must be absent: a side has no source')
    if (scopes[1]?.length) return 'owned source created by the unit: no coverage baseline'
    return scopes[0]?.length ? 'owned source removed by the unit' : 'no owned executable source'
  }
  if (!coverage || coverage.beforeSha !== before || coverage.afterSha !== options.finalSha)
    throw new Error('Missing/stale coverage reports with immutable refs')
  for (const [index, aggregate] of [coverage.report.before, coverage.report.after].entries()) {
    if (
      JSON.stringify(scopes[index]) !==
      JSON.stringify(aggregate?.files?.map((entry) => entry.file).sort())
    )
      throw new Error('Coverage reports must include the exact owned source scope')
  }
  if (!compareCoverage(coverage.report.before, coverage.report.after).pass)
    throw new Error('Owned statement coverage decreased')
}

/** Real test execution; an import failure is never assertion-red evidence. */
function runTests(options, sha, files, label) {
  files.forEach(testPath)
  return withSnapshot(options.root, sha, (snapshot) => {
    for (const file of files)
      if (!existsSync(join(snapshot, file))) throw new Error(`Missing ${label} test: ${file}`)
    const report = join(snapshot, '..', 'vitest-report.json')
    const command = [
      process.execPath,
      join(snapshot, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--maxWorkers=2',
      '--reporter=json',
      `--outputFile=${report}`,
      ...files,
    ]
    const result = spawnSync(command[0], command.slice(1), {
      cwd: snapshot,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error) throw result.error
    if (!existsSync(report))
      throw new Error(`${label} produced no execution report: ${result.stderr}`)
    const raw = JSON.parse(readFileSync(report, 'utf8'))
    if (!Array.isArray(raw.testResults) || raw.testResults.length === 0)
      throw new Error(`${label} has no tests`)
    const assertions = raw.testResults.flatMap((suite) => suite.assertionResults ?? [])
    return {
      label,
      sha,
      files,
      command,
      status: result.status,
      passed: assertions.filter((test) => test.status === 'passed').length,
      failed: assertions.filter((test) => test.status === 'failed').length,
      suiteErrors: raw.testResults.filter(
        (suite) =>
          suite.status === 'failed' &&
          !suite.assertionResults?.some((test) => test.status === 'failed'),
      ).length,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      report: raw,
    }
  })
}

function regressionCommits(options, commits) {
  const regressions = commits.filter((commit) => regression(commit, options.unit.id))
  if (behavior(options.unit) && !regressions.length)
    throw new Error('Behavior unit requires assertion-red regression commit')
  if (regressions.length) {
    const first = commits.indexOf(regressions[0])
    if (
      commits
        .slice(0, first + 1)
        .some(
          (commit, index) => !testOnly(options, commit, commits[index - 1]?.sha ?? options.baseSha),
        )
    )
      throw new Error('Source changed before or in first regression commit')
  }
  for (const commit of regressions)
    if (
      !commit.files.some(testFile) ||
      !testOnly(options, commit, commits[commits.indexOf(commit) - 1]?.sha ?? options.baseSha)
    )
      throw new Error('Every regression commit must be test-only')
  return regressions
}

function commitMetadata(options, history) {
  let previous = options.baseSha
  return history.map((sha) => {
    const commit = {
      sha,
      subject: gitText(options.root, 'log', '-1', '--format=%s', sha).trim(),
      files: changedPaths(options.root, previous, sha),
    }
    previous = sha
    if (
      !new RegExp(
        `^(test|fix|feat|refactor|perf|chore|docs|build|ci)\\(${options.unit.id}\\): \\S`,
      ).test(commit.subject)
    )
      throw new Error(`Invalid unit commit subject: ${commit.subject}`)
    return commit
  })
}

function verifyTests(options, evidence, context) {
  const { selection, characterized, regressions, history, relocation } = context
  const testCommits = evidence.commits.filter(
    (commit) => commit.sha === options.characterizationSha || regressions.includes(commit),
  )
  for (const commit of testCommits) {
    evidence.frozen.push(
      ...frozenBlobs(
        options.root,
        commit.sha,
        history.slice(history.indexOf(commit.sha) + 1),
        commit.files,
        relocation,
      ),
    )
    const label = regression(commit, options.unit.id) ? 'regression' : 'characterization'
    const run = runTests(options, commit.sha, commit.files.filter(testFile), label)
    evidence.runs.push(run)
    if (label === 'characterization') {
      if (run.status !== 0 || run.failed || run.suiteErrors || !run.passed)
        throw new Error('Characterization tests must pass on unchanged implementation')
    } else if (run.status === 0 || !run.failed || run.suiteErrors)
      throw new Error(`Every regression must fail by assertion at its own commit: ${commit.sha}`)
  }
  const full = evidence.commits.some((commit) => commit.files.some(rootConfig))
  const required = [
    ...new Set([
      ...selection.tests,
      ...characterized.filter(testFile),
      ...regressions.flatMap((commit) => commit.files.filter(testFile)),
    ]),
  ]
  const finalFiles = required.map(
    (file) => relocation?.moves.find((move) => move.from === file)?.to ?? file,
  )
  if (full || finalFiles.length) {
    const run = runTests(options, options.finalSha, full ? [] : finalFiles, 'final')
    evidence.runs.push(run)
    if (run.status !== 0 || run.failed || run.suiteErrors || !run.passed)
      throw new Error('Final tests must pass (whole suite required after root config changes)')
  }
}

/** @param {GateOptions} options */
export function runUnitGate(options) {
  if (!options.evidencePath || existsSync(options.evidencePath))
    throw new Error('Unused evidencePath required (file exists or path missing)')
  /** @type {{version:number,pass:boolean,baseSha:string,finalSha:string,unit:Unit,
   * characterizationSha?:string,manifest:Manifest,coverage?:GateOptions['coverage'],coverageNote?:string,
   * relocation?:GateOptions['relocation'],commits:Commit[],frozen:{original:string,file:string,blob:string}[],
   * runs:Run[],failures:string[],runtime:{os:string,node:string}} */
  const evidence = {
    version: 1,
    pass: false,
    baseSha: options.baseSha,
    finalSha: options.finalSha,
    unit: options.unit,
    characterizationSha: options.characterizationSha,
    manifest: options.manifest,
    coverage: options.coverage,
    relocation: options.relocation,
    commits: [],
    frozen: [],
    runs: [],
    failures: [],
    runtime: { os: process.platform, node: process.version },
  }
  try {
    const selection = validateUnitSpec(options.unit)
    selection.tests.forEach(testPath)
    if (!/^[A-Za-z0-9-]+$/.test(options.unit.id)) throw new Error('Invalid unit id')
    const history = commitHistory(options.root, options.baseSha, options.finalSha)
    if (!history.length) throw new Error('Unit has no commits')
    evidence.commits = commitMetadata(options, history)
    ownership(options, evidence.commits)
    const relocation = relocationFor(options, evidence.commits)
    const characterized = characterize(options, evidence.commits)
    const regressions = regressionCommits(options, evidence.commits)
    evidence.coverageNote = coverageEvidence(options, relocation, regressions)
    verifyTests(options, evidence, { selection, characterized, regressions, history, relocation })
    evidence.pass = true
  } catch (error) {
    evidence.failures.push(error.message)
  }
  // Exclusive creation prevents a later run/squash from replacing the original proof.
  writeFileSync(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  return evidence
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--input')
      throw new Error('Usage: node tools/scripts/unit-gate.mjs --input gate.json')
    const result = runUnitGate(JSON.parse(readFileSync(process.argv[3], 'utf8')))
    console.log(JSON.stringify(result, null, 2))
    if (!result.pass) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
