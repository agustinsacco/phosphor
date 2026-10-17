import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIMITS, measureSource } from './size-spans.mjs'

export const PACKAGES = Object.freeze({
  desktop: 'apps/desktop',
  host: 'apps/host',
  control: 'apps/control',
  site: 'apps/site',
  shared: 'libs/shared',
  'session-runtime': 'libs/session-runtime',
  'pi-extensions': 'libs/pi-extensions',
  tooling: '',
})

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const safeFile = (file) =>
  nonempty(file) &&
  !/[\\*?[\]{}:]/.test(file) &&
  !file.startsWith('/') &&
  file.split('/').every((part) => part && part !== '.' && part !== '..')

function validateBudget(budget) {
  const errors = []
  if (
    !object(budget) ||
    budget.version !== 1 ||
    !Object.hasOwn(PACKAGES, budget.package) ||
    !object(budget.offenders) ||
    !Array.isArray(budget.exemptions) ||
    !object(budget.renames)
  )
    return ['Invalid baseline: expected version 1, package, offenders, exemptions and renames']
  for (const [key, lines] of Object.entries(budget.offenders)) {
    const [file, symbol, extra] = key.split('::')
    if (
      !safeFile(file) ||
      !nonempty(symbol) ||
      extra !== undefined ||
      !Number.isSafeInteger(lines) ||
      lines < 1
    )
      errors.push(`Invalid baseline offender: ${key}`)
  }
  const exemptions = new Set()
  for (const entry of budget.exemptions) {
    if (
      !object(entry) ||
      !safeFile(entry.file) ||
      !Object.hasOwn(LIMITS, entry.rule) ||
      !['declaration', 'generated'].includes(entry.kind) ||
      !nonempty(entry.rationale) ||
      !nonempty(entry.owner)
    ) {
      errors.push(
        'Invalid exemption: exact file/rule, declaration/generated kind, rationale and owner required',
      )
      continue
    }
    const key = `${entry.file}::${entry.rule}`
    if (exemptions.has(key)) errors.push(`Invalid duplicate exemption: ${key}`)
    exemptions.add(key)
  }
  const targets = new Set()
  for (const [from, to] of Object.entries(budget.renames)) {
    if (
      !safeFile(from) ||
      !safeFile(to) ||
      from === to ||
      targets.has(to) ||
      Object.hasOwn(budget.renames, to) ||
      !Object.keys(budget.offenders).some((key) => key.startsWith(`${from}::`))
    )
      errors.push(`Invalid rename mapping: ${from} -> ${to}`)
    targets.add(to)
  }
  return errors
}

function renamedBaseline(spans, budget, errors) {
  const files = new Set(spans.map((span) => span.file))
  const result = new Map()
  for (const [from, to] of Object.entries(budget.renames)) {
    if (files.has(from) || !files.has(to))
      errors.push(`Invalid rename: ${from} must be absent and ${to} present`)
  }
  for (const [key, lines] of Object.entries(budget.offenders)) {
    const separator = key.indexOf('::')
    const file = key.slice(0, separator)
    const mapped = `${budget.renames[file] ?? file}${key.slice(separator)}`
    if (result.has(mapped)) errors.push(`Invalid rename collision: ${mapped}`)
    result.set(mapped, lines)
  }
  return result
}

/** Baselines are a one-way ceiling, not an exemption and never rewritten by a check. */
export function evaluateBudget(spans, budget, { strict = false } = {}) {
  const errors = validateBudget(budget)
  if (errors.length) return { errors, offenders: {} }
  const ceilings = renamedBaseline(spans, budget, errors)
  const exemptions = new Map(
    budget.exemptions.map((entry) => [`${entry.file}::${entry.rule}`, false]),
  )
  const offenders = {}
  for (const span of spans) {
    if (span.lines <= LIMITS[span.rule]) continue
    const exemption = `${span.file}::${span.rule}`
    if (exemptions.has(exemption)) {
      exemptions.set(exemption, true)
      continue
    }
    offenders[span.key] = span.lines
    const ceiling = ceilings.get(span.key)
    const detail = `${span.key} (${span.rule}): ${span.lines} lines`
    if (ceiling === undefined) errors.push(`New offender ${detail}, limit ${LIMITS[span.rule]}`)
    else if (span.lines > ceiling) errors.push(`Grown offender ${detail}, baseline ${ceiling}`)
    else if (strict) errors.push(`Remaining baseline offender ${detail}`)
  }
  for (const [key, used] of exemptions) {
    if (!used) errors.push(`Stale exemption: ${key}`)
  }
  return { errors, offenders }
}

function packageFor(file) {
  for (const [name, prefix] of Object.entries(PACKAGES)) {
    if (prefix && file.startsWith(`${prefix}/`)) return [name, file.slice(prefix.length + 1)]
  }
  return ['tooling', file]
}

function sourceFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))
}

export function checkRepository(root, options = {}) {
  const errors = []
  const measurements = Object.fromEntries(Object.keys(PACKAGES).map((name) => [name, []]))
  for (const file of [...new Set(sourceFiles(root))].sort()) {
    const path = resolve(root, file)
    if (!existsSync(path)) continue // A tracked deletion removes its baseline debt.
    const [name, relative] = packageFor(file)
    try {
      measurements[name].push(...measureSource(relative, readFileSync(path, 'utf8')))
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
    }
  }
  const packages = {}
  for (const name of Object.keys(PACKAGES)) {
    try {
      const budget = JSON.parse(readFileSync(resolve(root, `tools/budgets/${name}.json`), 'utf8'))
      if (budget.package !== name) throw new Error(`Invalid baseline package: expected ${name}`)
      const result = evaluateBudget(measurements[name], budget, options)
      packages[name] = result.offenders
      errors.push(...result.errors.map((error) => `${name}: ${error}`))
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
    }
  }
  return { errors, packages }
}

function main(args) {
  if (args[0] !== 'check' || args.slice(1).some((arg) => arg !== '--strict') || args.length > 2) {
    console.error('Usage: node tools/scripts/size-budget.mjs check [--strict]')
    return 1
  }
  try {
    const result = checkRepository(process.cwd(), { strict: args.includes('--strict') })
    for (const error of result.errors) console.log(error)
    const debt = Object.values(result.packages).reduce(
      (count, entries) => count + Object.keys(entries).length,
      0,
    )
    console.log(
      `Size budgets: ${result.errors.length ? 'FAIL' : 'PASS'} (${debt} baseline offenders; 8 packages)`,
    )
    return result.errors.length ? 1 : 0
  } catch (error) {
    console.error(error.message)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2))
