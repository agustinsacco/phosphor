import type { CatalogSpec } from './domains/spec'

/** Friendly CLI spellings; the dispatcher only sees canonical catalog names. */
export const OP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  lanes: 'lane.list',
  archives: 'archive.list',
  hosts: 'hosts.list',
  artifacts: 'artifact.list',
  changes: 'audit.list',
  'mcp.status': 'mcp.check',
  'routine.pause': 'routine.disable',
  'routine.resume': 'routine.enable',
})

export const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
const camel = (name: string): string =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

export const canonicalName = (name: string): string => {
  const normalized = camel(name.replaceAll(' ', '.'))
  return Object.hasOwn(OP_ALIASES, normalized) ? OP_ALIASES[normalized]! : normalized
}

/** Try a two-word command before a shorthand that is also a domain (`hosts`). */
export function resolveOp(argv: readonly string[], catalog: readonly CatalogSpec[]) {
  const match = (name: string) => catalog.find((spec) => spec.name === canonicalName(name))
  const [first = '', second = ''] = argv
  const pair = match(`${first}.${second}`)
  return { spec: pair ?? match(first), consumed: pair ? 2 : 1 }
}

export function optionsEnd(argv: readonly string[]): number {
  const end = argv.indexOf('--')
  return end === -1 ? argv.length : end
}

/** Surface-only spelling check, without validating fields, availability or policy. */
export function helpArgv(argv: readonly string[], catalog: readonly CatalogSpec[]) {
  const { spec, consumed } = resolveOp(argv, catalog)
  const beforeSeparator = argv.slice(0, optionsEnd(argv))
  if (spec?.name === 'help') {
    const operands = beforeSeparator.slice(consumed)
    if (operands.length === 2 && operands.every((word) => /^\w[\w-]*$/.test(word)))
      return ['help', canonicalName(operands.join('.'))]
    return argv
  }
  if (beforeSeparator.some((arg) => arg === '--help' || arg === '-h')) {
    if (spec) return ['help', spec.name]
    const [word, flag] = argv
    if (
      argv.length === 2 &&
      (flag === '--help' || flag === '-h') &&
      word &&
      catalog.some((entry) => entry.name.startsWith(`${camel(word)}.`))
    )
      return ['help', camel(word)]
  }
  return argv
}

export function canonicalFlag(key: string): string {
  return camel(key)
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + Number(a[i] !== b[j])))
    row = next
  }
  return row[b.length]!
}

/** Only a unique nearest match inside a small edit radius is useful. */
export function suggestion(input: string, candidates: readonly string[]): string {
  if (input.length < 2 || input.length > 64) return ''
  const radius = input.length < 6 ? 1 : 2
  const ranked = [...new Set(candidates)]
    .filter((name) => Math.abs(name.length - input.length) <= radius)
    .map((name) => ({ name, distance: distance(input, name) }))
    .sort((a, b) => a.distance - b.distance)
  const [first, second] = ranked
  return first && first.distance <= radius && first.distance !== second?.distance
    ? ` Did you mean ${first.name}?`
    : ''
}

export function unknownOperation(argv: readonly string[], catalog: readonly CatalogSpec[]): string {
  const [word = '', token] = argv
  const [group = '', dottedVerb] = kebab(word).split('.')
  const names = [...catalog.map((spec) => spec.name), ...Object.keys(OP_ALIASES)].map(kebab)
  const verbs = names
    .filter((name) => name.startsWith(`${group}.`))
    .map((name) => name.slice(group.length + 1))
  const verb = dottedVerb ?? token
  const problem = verbs.length
    ? `Unknown ${group} verb.${verb ? suggestion(kebab(verb), verbs) : ''}`
    : `Unknown domain or command.${suggestion(
        group,
        names.map((name) => name.split('.')[0]!),
      )}`
  return `${problem} Use phosphor help.`
}
