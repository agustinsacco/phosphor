/** The browser-session fixture the web and admin suites share. */
import { ControlFailure } from '../http'
import { randomBytes } from 'node:crypto'
import { expect, vi } from 'vitest'
import { createApp } from '../app'
import { parseConfig } from '../config'
import { dependencies, userId } from '../test-support'

export const origin = 'https://phosphor-app.example.test'
export const clientId = '00000000-0000-4000-8000-000000000011'
export const otherId = '00000000-0000-4000-8000-000000000012'
export const sid = '00000000-0000-4000-8000-000000000013'
export const cookieName = '__Host-phosphor-session'
export const transactionName = '__Host-phosphor-transaction'
export function cookie(res: Response, name: string) {
  return res.headers
    .getSetCookie()
    .find((v) => v.startsWith(name + '='))!
    .split(';')[0]!
}
function webEnv() {
  return {
    CONTROL_WEB_ORIGIN: origin,
    WEB_DIR: '/missing',
    CONTROL_WEB_SESSION_KEYS: `first=${randomBytes(32).toString('base64url')}`,
    SUPABASE_SECRET_KEY: 'fixture',
    CONTROL_GRANT_KEYS: `grant=${randomBytes(32).toString('base64url')}`,
  }
}
/** The browser's GitHub sign-in against the fixture's fake Supabase. */
function signIn(app: ReturnType<typeof createApp>) {
  async function start() {
    const res = await app.request(origin + '/api/auth/start?returnTo=/machines')
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    const callback = new URL(location.searchParams.get('redirect_to')!)
    callback.searchParams.set('code', 'short-lived-code')
    return { res, location, callback, transaction: cookie(res, transactionName) }
  }
  async function login() {
    const started = await start()
    const res = await app.request(started.callback.href, {
      headers: { cookie: started.transaction },
    })
    expect(res.status).toBe(303)
    const sealed = cookie(res, cookieName)
    const view = await app.request(origin + '/api/auth/session', { headers: { cookie: sealed } })
    expect(view.status).toBe(200)
    return { res, sealed, view: (await view.json()) as { csrfToken: string }, started }
  }
  return { start, login }
}
/** A signed-in browser session against a real app. `rpc` answers names the fixture does not. */
export function fixture(rpc?: (name: string, args: Record<string, unknown>) => unknown) {
  const deps = dependencies()
  let now = deps.clock()
  deps.clock = () => now
  const env = webEnv()
  deps.config = parseConfig(env)
  let revoked = false,
    unavailable = false,
    refreshedUser = userId,
    refreshedSid = sid
  let gate: Promise<void> | undefined
  function access(id = userId, sessionId = sid) {
    return `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 120, aud: 'authenticated', sub: id, session_id: sessionId })).toString('base64url')}.c2ln`
  }
  const provider = () => ({
    access_token: access(refreshedUser, refreshedSid),
    refresh_token: 'refresh-secret',
    expires_in: 120,
    user: { id: refreshedUser },
    provider_token: 'DISCARD-GITHUB-SECRET',
  })
  deps.fetch = vi.fn(async (url) => {
    if (unavailable) throw new Error('secret upstream diagnostic')
    if (String(url).includes('logout')) return new Response(null, { status: 204 })
    if (String(url).includes('refresh_token')) await gate
    return Response.json(provider())
  })
  deps.supabase.rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (unavailable) throw new ControlFailure('unavailable')
    if (name === 'control_account') return { enabled: true, maxHosts: 20 }
    if (name === 'control_client_register')
      return { outcome: 'registered', client: { id: clientId, label: 'Web browser' } }
    if (name === 'control_web_client_status') return { outcome: revoked ? 'not-found' : 'active' }
    if (name === 'control_client_revoke') {
      revoked = true
      return { outcome: 'revoked' }
    }
    if (name === 'control_web_clients_list')
      return { clients: [{ id: clientId, label: 'Web browser', kind: 'web', revokedAt: null }] }
    return rpc ? rpc(name, args) : { outcome: 'not-found' }
  })
  const app = createApp(deps)
  return {
    deps,
    env,
    app,
    ...signIn(app),
    advance: () => {
      now += 70_000
    },
    revoke: () => {
      revoked = true
    },
    outage: () => {
      unavailable = true
    },
    changeIdentity: () => {
      refreshedUser = otherId
    },
    changeSid: () => {
      refreshedSid = otherId
    },
    delay: (value: Promise<void>) => {
      gate = value
    },
  }
}
export function mutationHeaders(sealed: string, csrf: string) {
  return { cookie: sealed, origin, 'x-phosphor-csrf': csrf, 'content-type': 'application/json' }
}
