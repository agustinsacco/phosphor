/** The browser-session fixture the web, admin and usage suites share. */
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
export const HOUR = 3_600_000
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
    const session = cookie(res, cookieName)
    const view = await app.request(origin + '/api/auth/session', { headers: { cookie: session } })
    expect(view.status).toBe(200)
    return { res, session, view: (await view.json()) as { csrfToken: string }, started }
  }
  return { start, login }
}
interface Row {
  owner: string
  client: string
  sid: string
  used: number
}
/** Supabase's live state as the session RPCs see it; tests flip these. */
interface Model {
  rows: Map<string, Row>
  live: { account: boolean; sid: boolean; up: boolean }
  now: () => number
}
/** An in-memory model of the session RPCs (the SQL itself is covered by supabase/tests). */
function sessionRpc({ rows, live, now }: Model, name: string, args: Record<string, unknown>) {
  const hash = String(args.p_handle_hash)
  const row = rows.get(hash)
  switch (name) {
    case 'control_account':
      return { enabled: live.account, maxHosts: 100 }
    case 'control_web_session_create':
      if (!live.account) return { outcome: 'account-disabled' }
      rows.set(hash, {
        owner: String(args.p_user),
        client: clientId,
        sid: String(args.p_sid),
        used: now(),
      })
      return { outcome: 'created', clientId }
    case 'control_web_session_use': {
      if (!row) return { outcome: 'not-found' }
      if (now() - row.used > 90 * 24 * HOUR || !live.sid) {
        rows.delete(hash)
        return { outcome: 'not-found' }
      }
      if (!live.account) return { outcome: 'account-disabled' }
      const renewed = now() - row.used > HOUR
      if (renewed) row.used = now()
      const { owner: userId, client, sid } = row
      return { outcome: 'active', userId, login: 'tester', clientId: client, sid, renewed }
    }
    case 'control_web_session_end':
      return { outcome: rows.delete(hash) ? 'ended' : 'not-found' }
    case 'control_web_clients_list':
      return { clients: [{ id: clientId, label: 'Web browser', kind: 'web', revokedAt: null }] }
  }
  return undefined
}
/**
 * A signed-in browser session against a real app, over the session RPC model.
 * `rpc` answers names the model does not cover.
 */
export function fixture(rpc?: (name: string, args: Record<string, unknown>) => unknown) {
  const deps = dependencies()
  let now = deps.clock()
  deps.clock = () => now
  const env = webEnv()
  deps.config = parseConfig(env)
  const model: Model = {
    rows: new Map(),
    live: { account: true, sid: true, up: true },
    now: deps.clock,
  }
  const { rows, live } = model
  const codes = new Set<string>()
  const access = `e30.${Buffer.from(JSON.stringify({ aud: 'authenticated', sub: userId, session_id: sid })).toString('base64url')}.c2ln`
  deps.fetch = vi.fn(async (_url, init?: RequestInit) => {
    if (!live.up) throw new Error('secret upstream diagnostic')
    // Like Supabase, an authorization code exchanges once.
    const code = String((JSON.parse(String(init?.body)) as { auth_code: string }).auth_code)
    if (codes.has(code))
      return Response.json({ error_code: 'flow_state_not_found' }, { status: 400 })
    codes.add(code)
    return Response.json({
      access_token: access,
      refresh_token: 'refresh-secret',
      user: { id: userId, user_metadata: { user_name: 'tester' } },
      provider_token: 'DISCARD-GITHUB-SECRET',
    })
  })
  deps.supabase.rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (!live.up) throw new ControlFailure('unavailable')
    return sessionRpc(model, name, args) ?? (rpc ? rpc(name, args) : { outcome: 'not-found' })
  })
  const app = createApp(deps)
  return {
    deps,
    env,
    app,
    ...signIn(app),
    advance: (ms = 70_000) => {
      now += ms
    },
    /** Another device revoked this browser's client. */
    revoke: () => rows.clear(),
    disable: () => {
      live.account = false
    },
    endSupabaseSession: () => {
      live.sid = false
    },
    outage: () => {
      live.up = false
    },
    sessions: rows,
  }
}
export function mutationHeaders(session: string, csrf: string) {
  return { cookie: session, origin, 'x-phosphor-csrf': csrf, 'content-type': 'application/json' }
}
