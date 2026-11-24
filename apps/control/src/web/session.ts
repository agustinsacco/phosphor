import { createHash } from 'node:crypto'
import { isUuid } from '@phosphor/shared/control-api'
import type { Context } from 'hono'
import type { AppDeps } from '../app'
import type { User } from '../auth/user'
import { ControlFailure, type Env } from '../http'
import { record } from '../routes/shared'
import { WebCookies } from './cookies'
import type { ProviderIdentity } from './provider'

/** A browser session ends after 90 days unused. Use renews it (the database renews hourly). */
export const SESSION_IDLE_SEC = 90 * 86_400

const digest = (value: string) => createHash('sha256').update(value).digest()
/** The row's key. The handle itself never reaches the database. */
const handleHash = (handle: string) => digest(handle).toString('hex')
/** Derived, not stored: the page may read it, and it reveals nothing about the handle. */
const csrfToken = (handle: string) => digest('phosphor-csrf:' + handle).toString('base64url')

export interface WebSession {
  user: User
  clientId: string
  csrf: string
}
/**
 * Browser sessions live in Postgres (control_web_session_*), keyed by a random handle that
 * never changes. Any replica admits them and no restart, lost response or late cookie can
 * undo one. Only sign-out, revocation, 90 idle days or the Supabase session ending stop it.
 */
export function webSessions(deps: AppDeps) {
  const cookies = new WebCookies(deps.config.web!, deps.clock)
  const rpc = async (name: string, args: Record<string, unknown>) =>
    record(await deps.supabase.rpc(name, args))
  return {
    cookies,
    /** This browser's session, or null when it has none; an unknown handle is cleared. */
    async read(c: Context<Env>): Promise<WebSession | null> {
      const handle = cookies.handle(c)
      if (!handle) return null
      const value = await rpc('control_web_session_use', { p_handle_hash: handleHash(handle) })
      if (value.outcome === 'not-found') {
        cookies.clear(c, 'session')
        return null
      }
      if (value.outcome === 'account-disabled') throw new ControlFailure('forbidden')
      const { userId, clientId, sid, login } = value
      if (
        value.outcome !== 'active' ||
        !isUuid(userId) ||
        !isUuid(clientId) ||
        !isUuid(sid) ||
        !(login === null || (typeof login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(login)))
      )
        throw new ControlFailure('unavailable')
      if (value.renewed === true) cookies.writeHandle(c, handle, SESSION_IDLE_SEC)
      return { user: { userId, login, sid }, clientId, csrf: csrfToken(handle) }
    },
    async create(c: Context<Env>, identity: ProviderIdentity) {
      const handle = Buffer.from(deps.random(32)).toString('base64url')
      const value = await rpc('control_web_session_create', {
        p_user: identity.userId,
        p_login: identity.login,
        p_sid: identity.sid,
        p_handle_hash: handleHash(handle),
      })
      if (value.outcome === 'account-disabled') throw new ControlFailure('forbidden')
      if (value.outcome !== 'created' || !isUuid(value.clientId))
        throw new ControlFailure('unavailable')
      cookies.writeHandle(c, handle, SESSION_IDLE_SEC)
    },
    /** Revokes this browser's client and its Supabase session, then forgets the cookie. */
    async end(c: Context<Env>) {
      const handle = cookies.handle(c)
      if (!handle) throw new ControlFailure('unauthenticated')
      const value = await rpc('control_web_session_end', { p_handle_hash: handleHash(handle) })
      if (value.outcome !== 'ended' && value.outcome !== 'not-found')
        throw new ControlFailure('unavailable')
      cookies.clear(c, 'session')
    },
  }
}
