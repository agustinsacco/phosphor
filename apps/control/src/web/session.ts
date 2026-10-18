import { createHash } from 'node:crypto'
import { isUuid } from '@phosphor/shared/control-api'
import type { Context } from 'hono'
import type { AppDeps } from '../app'
import { ControlFailure, type Env } from '../http'
import type { createUserAuth } from '../auth/user'
import { record } from '../routes/shared'
import { WebCookies } from './cookies'
import { tokenClaims, webProvider, type ProviderSession } from './provider'

export interface BrowserSession extends ProviderSession {
  clientId: string
  csrf: string
  until: number
}
export class BrowserSessions {
  readonly cookies: WebCookies
  readonly provider: ReturnType<typeof webProvider>
  private readonly refreshes = new Map<
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
    if (session.expires <= this.deps.clock() + 60_000) {
      const key = createHash('sha256').update(session.refreshToken).digest('hex')
      for (const [id, item] of this.refreshes)
        if (item.until <= this.deps.clock()) this.refreshes.delete(id)
      let entry = this.refreshes.get(key)
      if (!entry) {
        if (this.refreshes.size >= 1000) throw new ControlFailure('too-many-requests')
        entry = {
          promise: this.provider.refresh(session.refreshToken),
          until: this.deps.clock() + 60_000,
        }
        this.refreshes.set(key, entry)
      }
      let refreshed: ProviderSession
      try {
        refreshed = await entry.promise
      } catch (error) {
        this.refreshes.delete(key)
        throw error
      }
      if (refreshed.userId !== session.userId || refreshed.sid !== session.sid)
        throw new ControlFailure('unauthenticated')
      session = { ...session, ...refreshed }
    }
    const user = await this.auth(`Bearer ${session.accessToken}`, c.get('ip'))
    if (user.userId !== session.userId) throw new ControlFailure('unauthenticated')
    await this.active(session)
    // Re-seal with the primary key on every admitted request, including key rotation.
    this.cookies.write(c, 'session', { ...session })
    return session
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
