import { Type } from 'typebox'
import { OPS_MAX_PAGE_ROWS } from '../host-protocol-ops'
import { canonicalName, kebab, OP_ALIASES, unknownOperation } from './aliases'
import { choices, integerRange } from './constraints'
import { argumentLabel, type CatalogSpec } from './domains/spec'
import { OP_CATALOG } from './index'

export const opCommand = (name: string) => kebab(name).replaceAll('.', ' ')
const unavailable = (s: CatalogSpec) => s.tier === 'never' || s.surfaceOnly === true

function fieldUsage(spec: CatalogSpec, key: string): string {
  const schema = spec.args.properties[key]!
  const positional = spec.positional?.includes(key)
  const label = argumentLabel(spec, key)
  const allowed = choices(schema)
  const range = integerRange(schema)
  const value = allowed ?? (Type.IsBoolean(schema) ? 'on|off' : undefined)
  const json = Type.IsObject(schema) || Type.IsUnknown(schema) || Type.IsRecord(schema)
  const placeholder =
    value ?? `<${label === 'revision' ? label : (range ?? (json ? 'json' : label))}>`
  const field = positional ? placeholder : `--${kebab(key)} ${placeholder}`
  return spec.args.required?.includes(key) ? field : `[${field}]`
}

export function opUsage(spec?: CatalogSpec): string {
  if (!spec) return 'Usage: phosphor <domain> <verb> [arguments] [options]'
  const positional = spec.positional ?? []
  const keys = [
    ...positional,
    ...Object.keys(spec.args.properties).filter(
      (k) => !positional.includes(k) && !(spec.paged && k === 'limit'),
    ),
  ]
  return [
    'Usage: phosphor',
    opCommand(spec.name),
    ...keys.map((key) => fieldUsage(spec, key)),
    '[options]',
  ].join(' ')
}

function options(spec: CatalogSpec): string {
  const range = spec.args.properties.limit ? integerRange(spec.args.properties.limit) : undefined
  return [
    ...(spec.routable === false ? [] : ['--host H|a,b|all']),
    ...(spec.paged
      ? ['--page <cursor>', `--limit <${range ?? `1–${OPS_MAX_PAGE_ROWS}`}> (default 20)`]
      : []),
    '--reason <text>',
    '--json',
    '--help',
  ].join(', ')
}

/** What `--host` accepts; `all` never includes the asking machine. */
const HOST_OPTION =
  '--host takes a machine name, an ID prefix of 8 or more hex characters, a,b, or all: every other machine, never this one.'

const examples: Partial<Record<string, string>> = {
  'lane.list': '--limit 10',
  'lane.read': 'host:machine/lane:lane-id --part messages',
  'mcp.check': 'server-name',
  'routine.edit': `routine-id --revision 1 --patch '{"name":"Daily digest"}'`,
  'files.read': 'README.md --target host:machine/lane:lane-id',
}

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

function overview(catalog: readonly CatalogSpec[]): string {
  const domains = new Set(
    catalog.filter((s) => s.name.includes('.')).map((s) => s.name.split('.')[0]),
  )
  const singles = catalog.filter((s) => !s.name.includes('.') && !unavailable(s)).map((s) => s.name)
  const aliases = Object.entries(OP_ALIASES)
    .filter(([, name]) => catalog.some((s) => s.name === name && !unavailable(s)))
    .map(([alias]) => opCommand(alias))
  return [
    opUsage(),
    `Domains: ${[...domains].map((name) => kebab(name!)).join(', ')}`,
    `Commands: ${singles.join(', ')}`,
    `Aliases: ${aliases.join(', ')}`,
    'Use phosphor help <domain> or phosphor help <domain.verb> for arguments and options.',
    ...(catalog.some((spec) => spec.routable !== false) ? [HOST_OPTION] : []),
    ...unavailableSection(catalog),
  ].join('\n')
}

/** A static catalog by default; owners provide the execution availability predicate. */
export function renderHelp(
  catalog: readonly CatalogSpec[] = OP_CATALOG,
  topic?: string,
  {
    tierNotes = true,
    unavailableReason = (_spec: CatalogSpec): string | undefined => undefined,
  } = {},
): string {
  const served = catalog.filter((s) => !unavailableReason(s))
  if (!topic) return overview(served)
  const name = canonicalName(topic)
  const group = catalog.filter((s) => s.name.startsWith(`${name}.`))
  if (group.length) {
    const available = group.filter((s) => !unavailableReason(s))
    if (!available.length) return `${opCommand(name)} has no operations on this binding.`
    return [
      `${opCommand(name)}:`,
      ...available
        .filter((s) => !unavailable(s))
        .map((s) => `  ${s.name}: ${s.summary}${tierNotes ? note(s) : ''}`),
      ...unavailableSection(available),
    ].join('\n')
  }
  const spec = catalog.find((s) => s.name === name)
  if (!spec) return `Unknown help topic. ${unknownOperation([topic], catalog)}`
  const why = unavailableReason(spec)
  if (why) return why
  if (unavailable(spec)) return unavailableSection([spec]).join('\n')
  const example = examples[spec.name]
  return [
    opUsage(spec),
    spec.summary + (tierNotes ? note(spec) : ''),
    `Options: ${options(spec)}`,
    ...(spec.name === 'lane.read' ? ['Defaults: --part summary, --messages 20.'] : []),
    ...(spec.name === 'service.update'
      ? ['Also: phosphor service.update. Top-level phosphor update is the installer.']
      : []),
    ...(example && (spec.name !== 'lane.list' || spec.paged)
      ? [`Example: phosphor ${opCommand(spec.name)} ${example}`]
      : []),
  ].join('\n')
}
