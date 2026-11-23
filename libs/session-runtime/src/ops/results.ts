/**
 * Small helpers every owner's op handlers share: a typed handler wrapper, a
 * result carrying bounded `data`, and offset paging. Living contract:
 * docs/agent-control.md.
 */
import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import type { OpArgs } from '@phosphor/shared/ops'
import { OpRefusal } from './builtins'
import { requestPage } from './ports'
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
export function pageRows(rows: readonly unknown[], ctx: OpHandlerContext, limit = 50) {
  const offset = pageOffset(ctx)
  let slice = rows.slice(offset, offset + limit)
  while (slice.length > 1 && Buffer.byteLength(JSON.stringify(slice)) > OPS_LIMITS.resultBytes / 2)
    slice = slice.slice(0, Math.ceil(slice.length / 2))
  const next = offset + slice.length
  return { ...dataResult(slice), ...(next < rows.length ? { next: String(next) } : {}) }
}
