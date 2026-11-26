import { Type, type TSchema } from 'typebox'
import { Check } from 'typebox/value'
import { normalizeLabel } from '../control-api'
import {
  OPS_LIMITS,
  OPS_MAX_PAGE_ROWS,
  parseOpsRunRequest,
  type OpsRunRequest,
} from '../host-protocol-ops'
import { canonicalFlag, helpArgv, kebab, resolveOp, suggestion, unknownOperation } from './aliases'
import { constraint, validateOpArgs } from './constraints'
import { record } from '../host-protocol/primitives'
import type { CatalogSpec } from './domains/spec'
import { opUsage } from './help'
import { OP_CATALOG } from './index'

type Hosts = readonly string[] | 'all'
type ToolFields = { content?: string; reason?: string }
type Options = { hosts?: Hosts; page?: string; limit?: number; reason?: string; json: boolean }
export type OpArgvResult =
  | ({ ok: true } & Pick<OpsRunRequest, 'op' | 'args'> & Options)
  | { ok: false; error: string; usage: string; op?: string }

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message)
}

function unknownFlag(key: string, spec: CatalogSpec): never {
  const flags = [
    'reason',
    'json',
    ...(spec.paged ? ['page', 'limit'] : []),
    ...(spec.routable === false ? [] : ['host']),
    ...Object.keys(spec.args.properties).filter((name) => name !== 'limit'),
  ].map((flag) => `--${kebab(flag)}`)
  const safe = /^[a-zA-Z][\w-]{0,63}$/.test(key) ? ` --${key}` : ''
  return fail(`Unknown flag${safe}.${safe ? suggestion(`--${key}`, flags) : ''}`)
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
    if (Check(schema, data) || Type.IsObject(schema) || Type.IsInteger(schema)) return data
  } catch {
    // No diagnostic includes a potentially sensitive argument value.
  }
  if (Type.IsUnion(schema)) {
    if (schema.anyOf.some(Type.IsBoolean) && (raw === 'on' || raw === 'off')) return raw === 'on'
    if (Check(schema, raw)) return raw
  }
  return fail(`${key}: expected ${constraint(schema)}.`)
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
  if (tool.content !== undefined && spec.name !== 'routine.create') {
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
    const flag = token.slice(2, equals < 0 ? undefined : equals)
    const key = canonicalFlag(flag)
    if (key === 'json') {
      if (options.json || equals !== -1) fail('Use --json once, without a value.')
      options.json = true
      continue
    }
    if (key === 'host' && spec.routable === false) fail('This operation does not accept --host.')
    if ((key === 'page' || key === 'limit') && !spec.paged)
      fail(`This operation does not accept --${key}; only paged operations do.`)
    if (
      !['host', 'reason', 'page', 'limit'].includes(key) &&
      !Object.hasOwn(spec.args.properties, key)
    )
      unknownFlag(flag, spec)
    const value = equals < 0 ? tokens[++i] : token.slice(equals + 1)
    if (value === undefined || (equals < 0 && value.startsWith('--')))
      fail(`Missing value for --${key}.`)
    if (key === 'host') {
      if (options.hosts !== undefined) fail('Duplicate --host.')
      options.hosts = hostsOption(value)
    } else if (key === 'limit') {
      const limit = Number(value)
      if (
        !/^\d+$/.test(value) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > OPS_MAX_PAGE_ROWS
      )
        fail(`limit: expected an integer 1–${OPS_MAX_PAGE_ROWS}.`)
      if (Object.hasOwn(spec.args.properties, key)) setArg(args, spec, key, String(limit))
      else {
        if (options.limit !== undefined) fail('Duplicate --limit.')
        options.limit = limit
      }
    } else if (key === 'page' || key === 'reason') {
      if (options[key] !== undefined) fail(`Duplicate --${key}.`)
      options[key] = value
    } else setArg(args, spec, key, value)
  }
  return { args, options }
}

function mergeRoutineInstructions(args: Record<string, unknown>, content: string) {
  if (!record(args.definition)) return // Schema validation names the absent or malformed definition.
  if (Object.hasOwn(args.definition, 'instructions')) fail('Duplicate definition.instructions.')
  args.definition = { ...args.definition, instructions: content }
}

function validateOptions(spec: CatalogSpec, args: Record<string, unknown>, options: Options) {
  const { page, reason, limit } = options
  if (parseOpsRunRequest({ op: spec.name, args, page, reason, limit })) return
  if (page !== undefined && !parseOpsRunRequest({ op: spec.name, args: {}, page }))
    fail(
      `page: expected a cursor of 1–${OPS_LIMITS.pageChars} letters, digits, hyphens or underscores.`,
    )
  if (reason !== undefined && !parseOpsRunRequest({ op: spec.name, args: {}, reason }))
    fail(`reason: expected text of 1–${OPS_LIMITS.reasonChars} characters.`)
  fail(`arguments: expected no more than ${OPS_LIMITS.argsBytes} UTF-8 bytes.`)
}

/** Parse CLI argv (without the executable) or a lane tool's argv and separate content/reason. */
export function parseOpArgv(
  argv: readonly string[],
  catalog: readonly CatalogSpec[] = OP_CATALOG,
  tool: ToolFields = {},
): OpArgvResult {
  const normalized = helpArgv(argv, catalog)
  const { spec, consumed } = resolveOp(normalized, catalog)
  if (!spec)
    return {
      ok: false,
      error: unknownOperation(argv, catalog),
      usage: opUsage(),
    }
  try {
    const { args, options } = readTokens(normalized.slice(consumed), spec, tool)
    if (spec.name === 'routine.create' && tool.content !== undefined)
      mergeRoutineInstructions(args, tool.content)
    const invalid = validateOpArgs(spec, args)
    if (invalid) fail(invalid)
    validateOptions(spec, args, options)
    return { ok: true, op: spec.name, args, ...options }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    return { ok: false, error: e.message, usage: opUsage(spec), op: spec.name }
  }
}
