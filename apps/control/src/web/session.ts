import { createHash } from 'node:crypto'
import { isUuid } from '@phosphor/shared/control-api'
import type { Context } from 'hono'
import type { AppDeps } from '../app'
import { ControlFailure, type Env } from '../http'
import type { createUserAuth } from '../auth/user'
import { record } from '../routes/shared'
import { WebCookies } from './cookies'
import { tokenClaims, webProvider, type ProviderSession } from './provider'

/** Absolute browser session lifetime from sign-in. Durable client status still gates every request. */
export const SESSION_LIFETIME_MS = 14 * 86_400_000
/**
 * How long a spent refresh token still resolves to its successor. A browser can miss
 * the rotated cookie (aborted fetch, suspended PWA, an older re-seal landing last) and
 * replay the previous one; Supabase would refuse the spent token, or revoke the session.
 */
const ROTATION_MEMORY_MS = 86_400_000
const ROTATION_LIMIT = 10_000

export interface BrowserSession extends ProviderSession {
  clientId: string
  csrf: string
  until: number
}
export class BrowserSessions {
  readonly cookies: WebCookies
  readonly provider: ReturnType<typeof webProvider>
  private readonly rotations = new Map<
    string,
    { promise: Promise<ProviderSession>; until: number }
  >()
  private readonly loggedOut = new Map<string, number>()
  constructor(
    readonly deps: AppDeps,
    readonly auth: ReturnType<typeof createUserAuth>,
  ) {
    this.cookies = new WebCookies(deps.config.web!, deps.clock)
    this.provider = webProvider(deps)
  }
  read(c: Context<Env>): BrowserSession | null {
    const data = this.cookies.read(c, 'session')
    if (!data) return null
    if (
      typeof data.accessToken !== 'string' ||
      typeof data.refreshToken !== 'string' ||
      !/^[\w.-]{1,2048}$/.test(data.refreshToken) ||
      !isUuid(data.clientId) ||
      typeof data.csrf !== 'string' ||
      !/^[\w-]{43}$/.test(data.csrf)
    )
      throw new ControlFailure('unauthenticated')
    const claims = tokenClaims(data.accessToken)
    if (claims.userId !== data.userId || claims.sid !== data.sid || claims.expires !== data.expires)
      throw new ControlFailure('unauthenticated')
    return data as unknown as BrowserSession
  }
  async active(session: BrowserSession) {
    if (this.loggedOut.has(session.clientId)) throw new ControlFailure('unauthenticated')
    const result = record(
      await this.deps.supabase.rpc('control_web_client_status', {
        p_user: session.userId,
        p_client: session.clientId,
      }),
    )
    if (result.outcome === 'not-found') throw new ControlFailure('unauthenticated')
    if (result.outcome !== 'active') throw new ControlFailure('unavailable')
    if (this.loggedOut.has(session.clientId)) throw new ControlFailure('unauthenticated')
  }
  async resolve(c: Context<Env>, original: BrowserSession): Promise<BrowserSession> {
    await this.active(original)
    let session = original
    // A stale cookie may sit several remembered rotations behind; follow them to the head.
    for (let hop = 0; session.expires <= this.deps.clock() + 60_000; hop++) {
      if (hop > ROTATION_LIMIT) throw new ControlFailure('unavailable')
      const { refreshed, remembered } = await this.rotate(session.refreshToken)
      if (refreshed.userId !== session.userId || refreshed.sid !== session.sid)
        throw new ControlFailure('unauthenticated')
      session = { ...session, ...refreshed }
      if (!remembered) break
    }
    const user = await this.auth(`Bearer ${session.accessToken}`, c.get('ip'))
    if (user.userId !== session.userId) throw new ControlFailure('unauthenticated')
    await this.active(session)
    // Re-seal with the primary key on every admitted request, including key rotation.
    this.cookies.write(c, 'session', { ...session })
    return session
  }
  /** One refresh per token, shared by concurrent callers and remembered for late replays. */
  private async rotate(refreshToken: string) {
    const key = createHash('sha256').update(refreshToken).digest('hex')
    const now = this.deps.clock()
    for (const [id, item] of this.rotations) if (item.until <= now) this.rotations.delete(id)
    let entry = this.rotations.get(key)
    const remembered = entry !== undefined
    if (!entry) {
      // Bounded memory: forget the oldest rotation rather than refuse a live refresh.
      while (this.rotations.size >= ROTATION_LIMIT)
        this.rotations.delete(this.rotations.keys().next().value!)
      entry = { promise: this.provider.refresh(refreshToken), until: now + ROTATION_MEMORY_MS }
      this.rotations.set(key, entry)
    }
    try {
      return { refreshed: await entry.promise, remembered }
    } catch (error) {
      if (this.rotations.get(key) === entry) this.rotations.delete(key)
      throw error
    }
  }
  async logout(c: Context<Env>, session: BrowserSession) {
    this.cookies.clear(c, 'session')
    for (const [id, until] of this.loggedOut)
      if (until <= this.deps.clock()) this.loggedOut.delete(id)
    // Supplementary only: durable refusal is the authoritative client-status RPC.
    if (this.loggedOut.size < 10_000) this.loggedOut.set(session.clientId, session.until)
    const results = await Promise.allSettled([
      this.deps.supabase
        .rpc('control_client_revoke', { p_user: session.userId, p_client: session.clientId })
        .then((value) => {
          if (!['revoked', 'not-found'].includes(String(record(value).outcome)))
            throw new ControlFailure('unavailable')
        }),
      this.provider.revoke(session.accessToken),
    ])
    return {
      signedOut: true as const,
      remoteCleanup: results.every((r) => r.status === 'fulfilled')
        ? ('complete' as const)
        : ('pending' as const),
    }
  }
}
