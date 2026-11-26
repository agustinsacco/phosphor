/**
 * Small helpers every owner's op handlers share: a typed handler wrapper, a
 * result carrying bounded `data`, and offset paging. Living contract:
 * docs/agent-control.md.
 */
import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import {
  AGENT_DIRECTIVE_KEYS,
  normalizeAgentDirectives,
  type AgentDirectivePrefs,
} from '@phosphor/shared/models'
import type { OpArgs } from '@phosphor/shared/ops'
import { OpRefusal } from './builtins'
import { requestLimit, requestPage } from './ports'
import type { OpHandler, OpHandlerContext, OpHandlerResult } from './types'

/** Dispatcher validates args against the named catalog schema before calling a handler. */
export function op<T = OpArgs>(
  fn: (a: T, c: OpHandlerContext) => OpHandlerResult | Promise<OpHandlerResult>,
): OpHandler {
  return async (args, ctx) => fn(args as T, ctx)
}
export function dataResult(data: unknown) {
  const text = JSON.stringify(data)
  if (Buffer.byteLength(text) > OPS_LIMITS.callDataBytes)
    throw new OpRefusal('too-large', 'Result too large; narrow the request.')
  return { text, data }
}
export function pageOffset(ctx: OpHandlerContext) {
  const page = requestPage(ctx)
  if (page === undefined) return 0
  if (!/^\d{1,15}$/.test(page)) throw new OpRefusal('bad-request', 'Invalid page.')
  return Number(page)
}
export function pageLimit(ctx: OpHandlerContext, fallback = 20) {
  const limit = requestLimit(ctx) ?? fallback
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new OpRefusal('bad-request', 'Limit must be an integer from 1 to 100.')
  return limit
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null')

function shortenStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') {
    if (value.length <= max) return value
    const chars = Array.from(value)
    return chars.length > max
      ? `${chars.slice(0, max).join('')}…(+${chars.length - max} chars)`
      : value
  }
  if (Array.isArray(value)) return value.map((v) => shortenStrings(v, max))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenStrings(v, max)]))
  }
  return value
}

function fitOversizedRow<T>(row: T): T {
  // Called only for a single row that cannot fit. Keep the shape, recursively
  // shortening long strings, and measure actual UTF-8 JSON (including escapes).
  const json = JSON.parse(JSON.stringify(row)) as unknown
  let lo = 0
  let hi: number = OPS_LIMITS.pageBytes
  let best = shortenStrings(json, lo)
  if (bytes([best]) > OPS_LIMITS.pageBytes)
    throw new OpRefusal('too-large', 'One inventory row is too large even without its text fields.')
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = shortenStrings(json, mid)
    if (bytes([candidate]) > OPS_LIMITS.pageBytes) hi = mid
    else {
      best = candidate
      lo = mid
    }
  }
  return best as T
}

export function fitInventory<T>(rows: readonly T[], limit: number): T[] {
  const shown: T[] = []
  let used = 2 // brackets
  for (const row of rows.slice(0, limit)) {
    const size = bytes(row) + (shown.length === 0 ? 0 : 1)
    if (used + size > OPS_LIMITS.pageBytes) {
      if (shown.length === 0) shown.push(fitOversizedRow(row))
      break
    }
    shown.push(row)
    used += size
  }
  return shown
}

type Columns<T> = Readonly<Record<string, (row: T) => unknown>>

export function rowTime(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string' && !(value instanceof Date)) return ''
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? `${time.toISOString().slice(0, 16)}Z` : ''
}

function cell(value: unknown, identifier: boolean) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  const line = text.replace(/[\r\n\u2028\u2029]+/g, ' ')
  if (identifier) return line
  const chars = Array.from(line)
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : chars.join('')
}

export function inventoryText<T>(rows: readonly T[], columns: Columns<T>) {
  const project = Object.entries(columns)
  return [
    Object.keys(columns).join(' | '),
    ...rows.map((r) =>
      project
        .map(([name, f]) => cell(f(r), name === 'ref' || name === 'key' || name === 'laneRef'))
        .join(' | '),
    ),
  ].join('\n')
}

interface LegacyPage {
  limit: number
  /** Earlier inventories could fit multiple rows below this size, or send one full row. */
  shrink?: true
}

export function surfaceInventory(ctx: OpHandlerContext) {
  return ctx.principal?.kind === 'surface'
}

function legacyRows<T>(rows: readonly T[], options: LegacyPage) {
  let shown = rows.slice(0, options.limit)
  if (options.shrink) {
    while (shown.length > 1 && bytes(shown) > OPS_LIMITS.resultBytes / 2)
      shown = shown.slice(0, Math.ceil(shown.length / 2))
  }
  return shown
}

/** Page a complete inventory, or an offset window fetched with one lookahead row. */
export function pageInventory<T, D = T[], A = T>(
  rows: readonly T[],
  ctx: OpHandlerContext,
  columns: Columns<T>,
  options?: {
    wrap?: (rows: T[], next?: string) => D
    windowOffset?: number
    limit?: number
    surface?: LegacyPage
    agent?: { row: (row: T) => A; columns: Columns<A> }
  },
) {
  const start = options?.windowOffset ?? pageOffset(ctx)
  const remaining = options?.windowOffset === undefined ? rows.slice(start) : rows
  const cursor = (count: number) =>
    remaining.length > count ? { next: String(start + count) } : {}
  const surface = surfaceInventory(ctx)
  const limit = options?.limit ?? pageLimit(ctx)
  if (!surface && options?.agent) {
    const data = fitInventory(remaining.slice(0, limit).map(options.agent.row), limit)
    return { text: inventoryText(data, options.agent.columns), data, ...cursor(data.length) }
  }
  const shown = surface
    ? legacyRows(remaining, options?.surface ?? { limit })
    : fitInventory(remaining, limit)
  const continuation = cursor(shown.length)
  const data = options?.wrap ? options.wrap(shown, continuation.next) : shown
  const text = surface && options?.surface ? dataResult(data).text : inventoryText(shown, columns)
  return { text, data, ...continuation }
}

/** Same column order and timestamp labels on both owners. */
export function fields<K extends string>(...keys: K[]): Columns<Partial<Record<K, unknown>>> {
  return Object.fromEntries(
    keys.map((key) => [key, (row: Partial<Record<K, unknown>>) => row[key]]),
  )
}

export const routineColumns = {
  ...fields('id', 'name'),
  schedule: (r: { schedule: { kind: string; expression?: string; at?: number } }) =>
    r.schedule.expression ??
    (r.schedule.at === undefined ? r.schedule.kind : rowTime(r.schedule.at)),
  ...fields('enabled'),
  next: (r: { nextAt: number | null }) => rowTime(r.nextAt),
}

export const routineRunColumns = {
  ...fields('id', 'routineId', 'status'),
  scheduled: (r: { scheduledAt: number }) => rowTime(r.scheduledAt),
  ended: (r: { endedAt: number | null }) => rowTime(r.endedAt),
  ...fields('laneRef'),
}

export const modelColumns = {
  ...fields('id', 'provider'),
  context: (r: { contextWindow?: number }) => r.contextWindow,
  ...fields('reasoning'),
}

export function cachedMcpStatus(server: { name: string; state?: string }, checkedAt?: number) {
  const age =
    checkedAt === undefined
      ? 'age unknown'
      : `${Math.max(0, Math.floor((Date.now() - checkedAt) / 1000))}s old`
  return `${server.name}: ${server.state ?? 'not checked'}. Cached status (${age}); use Settings for a live check.`
}

export function directiveResult(
  global: Partial<AgentDirectivePrefs> | undefined,
  project?: Partial<AgentDirectivePrefs> | null,
) {
  const overrides = project === undefined ? global : project
  const effective = normalizeAgentDirectives(project ?? global)
  const data = AGENT_DIRECTIVE_KEYS.map((key) => ({
    key,
    override: overrides?.[key] ?? null,
    effective: effective[key],
  }))
  return { text: inventoryText(data, fields('key', 'override', 'effective')), data }
}
