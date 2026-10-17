/**
 * Explicit selection, never `vitest related` or a Vite dependency graph.
 * Input is a plan unit: {owns, characterize_first:[{test}], new_tests:[{test}],
 * existing_tests:[path], importChanges?:[{consumer: projectName, library: projectName}]}.
 * CLI: --unit unit.json [--run]. Prints exact files and warnings before optional execution.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// host-release has no project.json; tooling owns these release checks.
export const SUPPLEMENTAL_ROOTS = { tooling: ['tools/host-release'] }
export const ROOT_SUITE_INPUTS = [
  'vitest.config.ts',
  'package.json',
  'package-lock.json',
  'tsconfig*.json',
  'eslint.config.js',
]
const isRootSuiteInput = (path) =>
  ROOT_SUITE_INPUTS.includes(path) || /^tsconfig[^/]*\.json$/.test(path)
const isCodePath = (path) => /\.(?:[cm]?[jt]sx?|sh|ps1)$/.test(path) || isRootSuiteInput(path)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
export function repoPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error(`Invalid repository path: ${value}`)
  return value
}

export function loadProjectRoots(root = process.cwd()) {
  const projects = []
  const inspect = (directory) => {
    const config = join(directory, 'project.json')
    if (!existsSync(config)) return
    const project = readJson(config)
    if (typeof project.name !== 'string' || !project.name)
      throw new Error(`Invalid project: ${config}`)
    const path = repoPath(project.root ?? relative(root, directory).replaceAll('\\', '/'))
    if (project.sourceRoot) repoPath(project.sourceRoot)
    if (projects.some((entry) => entry.name === project.name))
      throw new Error('Duplicate project name')
    projects.push({
      name: project.name,
      roots: [path, ...(SUPPLEMENTAL_ROOTS[project.name] ?? [])],
    })
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      ['node_modules', 'release', 'dist'].includes(entry.name)
    )
      continue
    const directory = join(root, entry.name)
    inspect(directory)
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (child.isDirectory() && !child.name.startsWith('.') && child.name !== 'node_modules')
        inspect(join(directory, child.name))
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

export function owningProject(file, projects) {
  const matches = projects.flatMap((project) =>
    project.roots
      .filter((root) => file === root || file.startsWith(`${root}/`))
      .map((root) => ({ project: project.name, root })),
  )
  matches.sort((a, b) => b.root.length - a.root.length)
  if (!matches.length) throw new Error(`No owning project for ${file}`)
  return matches[0]
}

export function validateUnitSpec(unit) {
  if (!unit || typeof unit !== 'object' || !Array.isArray(unit.owns) || !unit.owns.length)
    throw new Error('Unit requires owns')
  const tests = []
  for (const key of ['characterize_first', 'new_tests']) {
    if (unit[key] !== undefined && !Array.isArray(unit[key])) throw new Error(`Invalid ${key}`)
    for (const entry of unit[key] ?? []) tests.push(repoPath(entry?.test))
  }
  if (unit.existing_tests !== undefined && !Array.isArray(unit.existing_tests))
    throw new Error('Invalid existing_tests')
  for (const test of unit.existing_tests ?? []) tests.push(repoPath(test))
  const warnings = []
  const owns = unit.owns.flatMap((entry) => {
    const path = typeof entry === 'string' ? entry.replace(/\s*\(.*\)\s*$/, '').trim() : ''
    if ((!path.includes('/') && !path.includes('.')) || /[*?{}[\]]/.test(path)) {
      warnings.push(`Skipped non-path or glob ownership: ${String(entry)}`)
      return []
    }
    return [repoPath(path)]
  })
  if (!owns.length) throw new Error('No exact ownership paths')
  const noTests = unit.kind === 'docs' || owns.every((path) => !isCodePath(path))
  if (!tests.length && !noTests) throw new Error('Empty explicit test selection')
  const importChanges = unit.importChanges ?? []
  if (
    !Array.isArray(importChanges) ||
    importChanges.some(
      (edge) => !edge || typeof edge.consumer !== 'string' || typeof edge.library !== 'string',
    )
  )
    throw new Error('Invalid importChanges')
  return { tests: [...new Set(tests)], owns, importChanges, warnings, noTests }
}

export function selectUnitTests(unit, availableFiles, projects = loadProjectRoots()) {
  const selection = validateUnitSpec(unit)
  const names = new Set()
  for (const path of selection.owns) {
    if (isRootSuiteInput(path)) continue
    try {
      names.add(owningProject(path, projects).project)
    } catch (error) {
      if (isCodePath(path)) throw error
      selection.warnings.push(`Skipped unowned non-code ownership: ${path}`)
    }
  }
  for (const edge of selection.importChanges)
    for (const name of [edge.consumer, edge.library]) {
      if (!projects.some((project) => project.name === name))
        throw new Error(`Unknown project: ${name}`)
      names.add(name)
    }
  if (
    (unit.kind === 'docs' || (selection.noTests && !names.size)) &&
    !selection.tests.length &&
    !selection.importChanges.length
  ) {
    return {
      status: 'no-tests',
      reason: 'Documentation or non-code ownership only',
      files: [],
      projects: [],
      warnings: selection.warnings,
    }
  }
  if (!selection.tests.length) throw new Error('Empty explicit test selection')
  if (!Array.isArray(availableFiles) || !availableFiles.length)
    throw new Error('Empty available test inventory')
  const available = new Set(availableFiles.map(repoPath))
  for (const test of selection.tests) {
    if (!available.has(test)) throw new Error(`Missing explicit test: ${test}`)
    names.add(owningProject(test, projects).project)
  }
  if (selection.owns.some(isRootSuiteInput)) {
    for (const file of available) names.add(owningProject(file, projects).project)
  }
  if (!names.size) throw new Error('No owning package or explicit test')
  const files = new Set(selection.tests)
  for (const file of available)
    if (names.has(owningProject(file, projects).project)) files.add(file)
  for (const name of names) {
    if (![...available].some((file) => owningProject(file, projects).project === name))
      throw new Error(`Empty owning suite: ${name}`)
  }
  return { files: [...files].sort(), projects: [...names].sort(), warnings: selection.warnings }
}

// Use Vitest's file globbing only: no imports or Monaco resolution during selection.
export function listTestFiles(root = process.cwd()) {
  const temporary = mkdtempSync(join(tmpdir(), 'phosphor-test-selection-'))
  try {
    const report = join(temporary, 'files.json')
    execFileSync(
      process.execPath,
      [join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', `--json=${report}`],
      { cwd: root, stdio: 'pipe' },
    )
    const files = readJson(report)
    if (!Array.isArray(files) || !files.length) throw new Error('Empty file inventory')
    return files.map((entry) => {
      if (typeof entry.file !== 'string' || !isAbsolute(entry.file))
        throw new Error('Invalid file inventory')
      return repoPath(relative(root, entry.file).replaceAll('\\', '/'))
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function main(args) {
  const index = args.indexOf('--unit')
  if (index < 0 || !args[index + 1]) throw new Error('Required: --unit unit.json [--run]')
  const unit = readJson(args[index + 1])
  const validated = validateUnitSpec(unit)
  const available =
    validated.noTests && !validated.tests.length && !validated.importChanges.length
      ? []
      : listTestFiles()
  const selection = selectUnitTests(unit, available)
  console.log(JSON.stringify(selection, null, 2))
  if (args.includes('--run') && selection.status !== 'no-tests') {
    for (const file of selection.files)
      if (!existsSync(resolve(file))) throw new Error(`Missing test file: ${file}`)
    const result = spawnSync(
      process.execPath,
      [resolve('node_modules/vitest/vitest.mjs'), 'run', ...selection.files],
      { stdio: 'inherit' },
    )
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
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
