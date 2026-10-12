import { createHash } from 'node:crypto'
import { isUuid, parseMeResponse, type MeResponse } from '@phosphor/shared/control-api'
import type { MiddlewareHandler } from 'hono'
import { ControlFailure, type Env } from '../http'
import { BoundedCache, type RateLimiter } from '../limits'
import type { Supabase } from '../supabase'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export interface User {
  userId: string
  login: string | null
}
export function createUserAuth(supabase: Supabase, clock: () => number, limits: RateLimiter) {
  const cache = new BoundedCache<User>(clock, 1000)
  return async (authorization: string | undefined, ip: string): Promise<User> => {
    if (!authorization?.startsWith('Bearer ')) throw new ControlFailure('unauthenticated')
    const token = authorization.slice(7)
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      throw new ControlFailure('unauthenticated')
    let payload: unknown
    try {
      const part = token.split('.')[1]
      if (!part) throw new Error('missing payload')
      payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    } catch {
      throw new ControlFailure('unauthenticated')
    }
    if (
      !record(payload) ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp * 1000 <= clock() ||
      payload.aud !== 'authenticated'
    )
      throw new ControlFailure('unauthenticated')
    const hash = createHash('sha256').update(token).digest('hex')
    const cached = cache.get(hash)
    if (cached) return cached
    if (!limits.consume('user-verify:' + ip, 30, 60_000))
      throw new ControlFailure('too-many-requests')
    const value = await supabase.getUser(token)
    if (payload.exp * 1000 <= clock()) throw new ControlFailure('unauthenticated')
    if (!record(value) || !isUuid(value.id)) throw new ControlFailure('unavailable')
    const login =
      record(value.user_metadata) &&
      typeof value.user_metadata.user_name === 'string' &&
      /^[A-Za-z0-9-]{1,39}$/.test(value.user_metadata.user_name)
        ? value.user_metadata.user_name
        : null
    const user = { userId: value.id, login }
    cache.set(hash, user, Math.min(clock() + 30_000, payload.exp * 1000))
    return user
  }
}
export async function account(supabase: Supabase, user: User): Promise<MeResponse> {
  const value = await supabase.rpc('control_account', {
    p_user_id: user.userId,
    p_login: user.login,
  })
  if (!record(value)) throw new ControlFailure('unavailable')
  const parsed = parseMeResponse({
    account: { login: user.login },
    enabled: value.enabled,
    maxHosts: value.maxHosts,
  })
  if (!parsed.ok) throw new ControlFailure('unavailable')
  return parsed.value
}
/** All user routes except /me use this guard. Account suspension is never cached. */
export function userGuard(
  auth: ReturnType<typeof createUserAuth>,
  supabase: Supabase,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const user = await auth(c.req.header('authorization'), c.get('ip'))
    c.set('user', user)
    c.set('actor', `user:${user.userId}`)
    if (!(await account(supabase, user)).enabled) throw new ControlFailure('forbidden')
    await next()
  }
}
