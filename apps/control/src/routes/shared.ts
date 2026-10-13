import type { Context } from 'hono'
import type { Parsed, ControlErrorCode } from '@phosphor/shared/control-api'
import { ControlFailure, rawTarget, type Env } from '../http'
import { authenticateHost, type HostAuthDeps } from '../auth/host'

export function parsed<T>(result: Parsed<T>, code: ControlErrorCode = 'unavailable'): T {
  if (!result.ok) throw new ControlFailure(code)
  return result.value
}
export function body(c: Context<Env>): unknown {
  return JSON.parse(new TextDecoder().decode(c.get('rawBody')))
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ControlFailure('unavailable')
  return value
}
export function outcome(value: Record<string, unknown>, success: string): void {
  if (value.outcome === success) return
  switch (value.outcome) {
    case 'not-found':
      throw new ControlFailure('not-found')
    case 'gone':
      throw new ControlFailure('gone')
    case 'key-in-use':
    case 'host-limit':
    case 'stale':
      throw new ControlFailure('conflict')
    case 'too-soon':
    case 'too-many-requests':
      throw new ControlFailure('too-many-requests')
    case 'account-disabled':
      throw new ControlFailure('forbidden')
    default:
      throw new ControlFailure('unavailable')
  }
}
export async function host(c: Context<Env>, deps: HostAuthDeps, mode: 'key' | 'host') {
  const identity = await authenticateHost(
    c.req.raw,
    c.get('rawBody'),
    deps,
    mode,
    c.get('ip'),
    rawTarget(c.req.raw, c.env),
  )
  if (mode === 'host') c.set('actor', `host:${identity}`)
  return identity
}
export function emptyBody(c: Context<Env>): void {
  const value = body(c)
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length
  )
    throw new ControlFailure('bad-request')
}
