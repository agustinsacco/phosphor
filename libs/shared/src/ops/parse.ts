import { Type, type TSchema } from 'typebox'
import { Check } from 'typebox/value'
import { normalizeLabel } from '../control-api'
import { OPS_LIMITS, parseOpsRunRequest, type OpsRunRequest } from '../host-protocol-ops'
import { canonicalName } from './aliases'
import type { CatalogSpec } from './domains/spec'
import { opUsage } from './help'
import { OP_CATALOG } from './index'

type Hosts = readonly string[] | 'all'
type ToolFields = { content?: string; reason?: string }
type Options = { hosts?: Hosts; page?: string; reason?: string; json: boolean }
export type OpArgvResult =
  | ({ ok: true } & Pick<OpsRunRequest, 'op' | 'args'> & Options)
  | { ok: false; error: string; usage: string }

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message)
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + Number(a[i] !== b[j])))
    }
    row = next
  }
  return row[b.length]!
}

function unknownFlag(key: string, spec: CatalogSpec): never {
  const flags = [
    'reason',
    'page',
    'json',
    ...(spec.routable === false ? [] : ['host']),
    ...Object.keys(spec.args.properties),
  ]
  const shown = key.slice(0, 64)
  const closest = flags
    .map((flag) => ({ flag, distance: editDistance(shown, flag) }))
    .sort((a, b) => a.distance - b.distance)[0]!
  return fail(`Unknown flag --${shown}. Did you mean --${closest.flag}?`)
}

function hostsOption(value: string): Hosts {
  if (value === 'all') return 'all'
  const names = value.split(',').map((n) => n.trim())
  if (
    names.length > OPS_LIMITS.hostsPerBatch ||
    names.some((n) => !normalizeLabel(n) || n.toLowerCase() === 'all')
  )
    fail(
      `Use --host all or up to ${OPS_LIMITS.hostsPerBatch} comma-separated machine names or IDs.`,
    )
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length)
    fail('Duplicate machine in --host.')
  return names
}

function scalar(schema: TSchema, raw: string, key: string): unknown {
  if (Type.IsString(schema)) return raw
  if (Type.IsBoolean(schema) || (Type.IsLiteral(schema) && schema.type === 'boolean')) {
    if (raw === 'on' || raw === 'true') return true
    if (raw === 'off' || raw === 'false') return false
    return fail(`Use on, off, true or false for ${key}.`)
  }
  // Objects (including nested definitions) are one JSON argv token. In a union
  // prefer a matching JSON value; a plain string remains a string when allowed.
  try {
    const data: unknown = JSON.parse(raw)
    if (Check(schema, data)) return data
  } catch {
    // No diagnostic includes a potentially sensitive argument value.
  }
  if (Type.IsUnion(schema)) {
    if (schema.anyOf.some(Type.IsBoolean) && (raw === 'on' || raw === 'off')) return raw === 'on'
    if (Check(schema, raw)) return raw
  }
  return fail(`Invalid value for ${key}.`)
}

function setArg(args: Record<string, unknown>, spec: CatalogSpec, key: string, raw: string) {
  const schema = spec.args.properties[key]!
  if (Type.IsArray(schema)) {
    const previous = args[key]
    args[key] = [
      ...(Array.isArray(previous) ? previous : []),
      ...raw.split(',').map((s) => scalar(schema.items, s, key)),
    ]
  } else {
    if (Object.hasOwn(args, key)) fail(`Duplicate argument: ${key}.`)
    args[key] = scalar(schema, raw, key)
  }
}

/** Tokenize only options, never shell text. Quoting and whitespace inside an argv item are data. */
function readTokens(tokens: readonly string[], spec: CatalogSpec, tool: ToolFields) {
  const args: Record<string, unknown> = {}
  const options: Options = { json: false }
  if (tool.reason !== undefined) options.reason = tool.reason
  if (tool.content !== undefined) {
    if (!Object.hasOwn(spec.args.properties, 'content'))
      fail('This operation does not take content.')
    setArg(args, spec, 'content', tool.content)
  }
  let flags = true
  let position = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (flags && token === '--') {
      flags = false
      continue
    }
    if (!flags || !token.startsWith('--')) {
      const key = spec.positional?.[position++]
      if (!key) fail('Unexpected positional argument.')
      setArg(args, spec, key, token)
      continue
    }
    const equals = token.indexOf('=')
    const key = token.slice(2, equals < 0 ? undefined : equals)
    if (key === 'json') {
      if (options.json || equals !== -1) fail('Use --json once, without a value.')
      options.json = true
      continue
    }
    if (key === 'host' && spec.routable === false) fail('This operation does not accept --host.')
    if (!['host', 'reason', 'page'].includes(key) && !Object.hasOwn(spec.args.properties, key))
      unknownFlag(key, spec)
    const value = equals < 0 ? tokens[++i] : token.slice(equals + 1)
    if (value === undefined || (equals < 0 && value.startsWith('--')))
      fail(`Missing value for --${key}.`)
    if (key === 'host') {
      if (options.hosts !== undefined) fail('Duplicate --host.')
      options.hosts = hostsOption(value)
    } else if (key === 'page' || key === 'reason') {
      if (options[key] !== undefined) fail(`Duplicate --${key}.`)
      options[key] = value
    } else setArg(args, spec, key, value)
  }
  return { args, options }
}

/** Parse CLI argv (without the executable) or a lane tool's argv and separate content/reason. */
export function parseOpArgv(
  argv: readonly string[],
  catalog: readonly CatalogSpec[] = OP_CATALOG,
  tool: ToolFields = {},
): OpArgvResult {
  const pair = catalog.find((s) => s.name === `${argv[0]}.${argv[1]}`)
  const spec = pair ?? catalog.find((s) => s.name === canonicalName(argv[0] ?? ''))
  if (!spec)
    return {
      ok: false,
      error: 'Unknown operation. Use phosphor help to list domains.',
      usage: opUsage(),
    }
  try {
    const { args, options } = readTokens(argv.slice(pair ? 2 : 1), spec, tool)
    const { page, reason } = options
    if (!parseOpsRunRequest({ op: spec.name, args, page, reason }))
      fail('Invalid page cursor, reason or argument size.')
    const missing = spec.args.required?.find((k) => !Object.hasOwn(args, k))
    if (missing) fail(`Missing argument: ${missing}.`)
    if (!Check(spec.args, args)) fail(`Invalid arguments for ${spec.name}.`)
    return { ok: true, op: spec.name, args, ...options }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    return { ok: false, error: e.message, usage: opUsage(spec) }
  }
}
