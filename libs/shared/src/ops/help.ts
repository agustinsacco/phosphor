import { canonicalName, OP_ALIASES } from './aliases'
import type { CatalogSpec } from './domains/spec'
import { OP_CATALOG } from './index'

const command = (name: string) => name.replaceAll('.', ' ')
const unavailable = (s: CatalogSpec) => s.tier === 'never' || s.surfaceOnly === true

export function opUsage(spec?: CatalogSpec): string {
  if (!spec) return 'Usage: phosphor <domain> <verb> [arguments] [options]'
  const positional = spec.positional ?? []
  const keys = [
    ...positional,
    ...Object.keys(spec.args.properties).filter((k) => !positional.includes(k)),
  ]
  const args = keys.map((key) => {
    const field = positional.includes(key) ? `<${key}>` : `--${key} <value>`
    return spec.args.required?.includes(key) ? field : `[${field}]`
  })
  return ['Usage: phosphor', command(spec.name), ...args, '[options]'].join(' ')
}

function options(spec?: CatalogSpec): string {
  return `Options: ${spec?.routable === false ? '' : '--host H|a,b|all, '}--page <cursor>, --reason <text>, --json`
}

/** What `--host` accepts; `all` never includes the asking machine. */
const HOST_OPTION =
  '--host takes a machine name, an ID prefix of 8 or more hex characters, a,b, or all: every other machine, never this one.'

function note(spec: CatalogSpec): string {
  if (spec.tier === 'destructive') return ' Asks the user first.'
  if (typeof spec.tier === 'function' && spec.tier({}, { self: false }) === 'destructive')
    return ' Asks the user first for another lane.'
  return ''
}

function unavailableSection(specs: readonly CatalogSpec[]): string[] {
  const names = specs.filter(unavailable).map((s) => s.name)
  return names.length ? [`Not available to agents: ${names.join(', ')}`] : []
}

/** Describes the supplied catalog, not the set of handlers installed on a particular machine. */
export function renderHelp(
  catalog: readonly CatalogSpec[] = OP_CATALOG,
  topic?: string,
  { tierNotes = true } = {},
): string {
  if (!topic) {
    const domains = new Set(
      catalog.filter((s) => s.name.includes('.')).map((s) => s.name.split('.')[0]),
    )
    const singles = catalog
      .filter((s) => !s.name.includes('.') && !unavailable(s))
      .map((s) => s.name)
    const aliases = Object.entries(OP_ALIASES)
      .filter(([, name]) => catalog.some((s) => s.name === name))
      .map(([alias]) => alias)
    return [
      opUsage(),
      options(),
      HOST_OPTION,
      `Domains: ${[...domains].join(', ')}`,
      `Commands: ${singles.join(', ')}`,
      `Aliases: ${aliases.join(', ')}`,
      'Use phosphor help <domain> or phosphor help <domain.verb>.',
      ...unavailableSection(catalog),
    ].join('\n')
  }
  const group = catalog.filter((s) => s.name.startsWith(`${topic}.`))
  if (group.length)
    return [
      `${topic}:`,
      ...group
        .filter((s) => !unavailable(s))
        .map((s) => `  ${s.name}: ${s.summary}${tierNotes ? note(s) : ''}`),
      ...unavailableSection(group),
    ].join('\n')
  const spec = catalog.find((s) => s.name === canonicalName(topic))
  if (!spec) return `Unknown help topic. Use phosphor help to list domains.`
  if (unavailable(spec)) return unavailableSection([spec]).join('\n')
  return [opUsage(spec), spec.summary + (tierNotes ? note(spec) : ''), options(spec)].join('\n')
}
