import { ControlFailure } from '../http'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { parseConfig } from '../config'
import { dependencies, token, userId } from '../test-support'

const origin = 'https://phosphor-app.example.test'
const clientId = '00000000-0000-4000-8000-000000000011'
const otherId = '00000000-0000-4000-8000-000000000012'
const sid = '00000000-0000-4000-8000-000000000013'
const cookieName = '__Host-phosphor-session'
const transactionName = '__Host-phosphor-transaction'
function cookie(res: Response, name: string) {
  return res.headers
    .getSetCookie()
    .find((v) => v.startsWith(name + '='))!
    .split(';')[0]!
}
function fixture() {
  const deps = dependencies()
  let now = deps.clock()
  deps.clock = () => now
  const key = randomBytes(32).toString('base64url')
  const env = {
    CONTROL_WEB_ORIGIN: origin,
    WEB_DIR: '/missing',
    CONTROL_WEB_SESSION_KEYS: `first=${key}`,
    SUPABASE_SECRET_KEY: 'fixture',
    CONTROL_GRANT_KEYS: `grant=${randomBytes(32).toString('base64url')}`,
  }
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
  deps.supabase.rpc = vi.fn(async (name) => {
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
    return { outcome: 'not-found' }
  })
  const app = createApp(deps)
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
  return {
    deps,
    env,
    app,
    start,
    login,
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
function mutationHeaders(sealed: string, csrf: string) {
  return { cookie: sealed, origin, 'x-phosphor-csrf': csrf, 'content-type': 'application/json' }
}
describe('browser authentication boundary', () => {
  it('binds PKCE to encrypted transaction; emits only safe session fields and secure cookies', async () => {
    const f = fixture(),
      login = await f.login()
    expect(login.started.location.searchParams.get('code_challenge_method')).toBe('s256')
    expect(login.started.location.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(login.started.callback.origin).toBe(origin)
    expect(login.res.headers.get('location')).toBe('/machines')
    for (const res of [login.res, login.started.res]) {
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax')
      expect(res.headers.get('set-cookie')).toContain('Path=/')
      expect(res.headers.get('set-cookie')).toContain('Secure')
      expect(res.headers.get('set-cookie')).not.toContain('Domain=')
    }
    expect(login.view).toEqual({
      user: { id: userId, login: 'tester' },
      clientId,
      csrfToken: expect.stringMatching(/^[\w-]{43}$/),
    })
    const exposed = JSON.stringify([login.view, vi.mocked(f.deps.log).mock.calls])
    expect(exposed).not.toMatch(/refresh-secret|DISCARD-GITHUB|short-lived-code|access_token/)
    expect(f.deps.supabase.rpc).toHaveBeenCalledWith('control_client_register', {
      p_user: userId,
      p_label: 'Web browser',
      p_kind: 'web',
    })
  })
  it('refuses tampered, expired, mismatched, duplicate and replayed transactions', async () => {
    for (const mode of ['tampered', 'expired', 'state', 'duplicate', 'replay']) {
      const f = fixture(),
        s = await f.start()
      let transaction = s.transaction
      if (mode === 'tampered') transaction += 'x'
      if (mode === 'expired') for (let i = 0; i < 9; i++) f.advance()
      if (mode === 'state') s.callback.searchParams.set('state', 'a'.repeat(43))
      if (mode === 'duplicate') s.callback.searchParams.append('code', 'second')
      if (mode === 'replay')
        expect(
          (await f.app.request(s.callback.href, { headers: { cookie: transaction } })).status,
        ).toBe(303)
      const res = await f.app.request(s.callback.href, { headers: { cookie: transaction } })
      expect(res.status, mode).toBe(401)
      expect(await res.text()).not.toContain('short-lived-code')
    }
  })
  it('refuses unsafe return paths, cross-site start and wrong host/forwarded host', async () => {
    const f = fixture()
    for (const path of [
      '//evil.test',
      '/api/auth/session',
      '/\\evil',
      '/ok?token=secret',
      '/%2f%2fevil',
    ]) {
      expect(
        (await f.app.request(origin + '/api/auth/start?returnTo=' + encodeURIComponent(path)))
          .status,
      ).toBe(400)
    }
    expect(
      (
        await f.app.request(origin + '/api/auth/start', {
          headers: { 'sec-fetch-site': 'same-site' },
        })
      ).status,
    ).toBe(403)
    const wrong = await f.app.request('https://evil.test/api/auth/start', {
      headers: { 'x-forwarded-host': new URL(origin).host },
    })
    expect(wrong.status).toBe(404)
    expect(wrong.headers.get('location')).toBeNull()
    expect(
      (await f.app.request(origin + '/api/auth/start', { headers: { host: 'evil.test' } })).status,
    ).toBe(404)
  })
  it('requires both exact Origin and session CSRF for mutations, including sibling origins', async () => {
    const f = fixture(),
      l = await f.login()
    for (const [requestOrigin, csrf] of [
      [origin, 'wrong'],
      ['https://phosphor.example.test', l.view.csrfToken],
      ['https://evil.test', l.view.csrfToken],
      ['', l.view.csrfToken],
    ]) {
      const res = await f.app.request(origin + '/api/auth/signout', {
        method: 'POST',
        headers: { ...mutationHeaders(l.sealed, csrf!), origin: requestOrigin! },
        body: '{}',
      })
      expect(res.status).toBe(403)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect(
      (
        await f.app.request(origin + '/api/v1/clients/' + clientId, {
          method: 'DELETE',
          headers: { cookie: l.sealed },
        })
      ).status,
    ).toBe(403)
  })
  it('keeps site bearer-only and rejects app bearer ambiguity', async () => {
    const f = fixture(),
      l = await f.login()
    expect(
      (
        await f.app.request('https://phosphor.example.test/api/v1/me', {
          headers: { cookie: l.sealed },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await f.app.request('https://phosphor.example.test/api/v1/me', {
          headers: {
            cookie: l.sealed,
            authorization: `Bearer ${token(f.deps.clock() / 1000 + 100)}`,
          },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await f.app.request(origin + '/api/auth/session', {
          headers: { cookie: l.sealed, authorization: 'Bearer anything' },
        })
      ).status,
    ).toBe(400)
  })
  it('refuses invalid cookies and sanitizes unavailable upstream responses', async () => {
    const f = fixture()
    expect(
      (
        await f.app.request(origin + '/api/auth/session', {
          headers: { cookie: cookieName + '=invalid' },
        })
      ).status,
    ).toBe(401)
    const start = await f.start()
    f.outage()
    const res = await f.app.request(start.callback.href, { headers: { cookie: start.transaction } })
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('secret')
  })
  it('rotates sealing keys and accepts a cookie in a second process without session memory', async () => {
    const f = fixture(),
      l = await f.login()
    f.deps.config = parseConfig({
      ...f.env,
      CONTROL_WEB_SESSION_KEYS: `second=${randomBytes(32).toString('base64url')},${f.env.CONTROL_WEB_SESSION_KEYS}`,
    })
    const second = createApp(f.deps)
    const res = await second.request(origin + '/api/auth/session', {
      headers: { cookie: l.sealed },
    })
    expect(res.status).toBe(200)
    expect(cookie(res, cookieName)).toContain('=second.')
  })
  it('coalesces refresh, checks verified user and session consistency, and retains session on transient failure', async () => {
    const f = fixture(),
      l = await f.login()
    f.advance()
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.app.request(origin + '/api/auth/session', { headers: { cookie: l.sealed } }),
      ),
    )
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(
      vi.mocked(f.deps.fetch).mock.calls.filter(([url]) => String(url).includes('refresh_token')),
    ).toHaveLength(1)
    for (const change of ['user', 'sid']) {
      const altered = fixture(),
        login = await altered.login()
      altered.advance()
      if (change === 'user') altered.changeIdentity()
      else altered.changeSid()
      expect(
        (
          await altered.app.request(origin + '/api/auth/session', {
            headers: { cookie: login.sealed },
          })
        ).status,
      ).toBe(401)
    }
    const outage = fixture(),
      login = await outage.login()
    outage.advance()
    outage.outage()
    const res = await outage.app.request(origin + '/api/auth/session', {
      headers: { cookie: login.sealed },
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('refuses re-registration, client substitution and all API use after device revoke', async () => {
    const f = fixture(),
      l = await f.login()
    expect(
      (
        await f.app.request(origin + '/api/v1/clients', {
          method: 'POST',
          headers: mutationHeaders(l.sealed, l.view.csrfToken),
          body: '{"label":"bypass"}',
        })
      ).status,
    ).toBe(403)
    const issue = (id: string) =>
      f.app.request(origin + '/api/v1/grants', {
        method: 'POST',
        headers: mutationHeaders(l.sealed, l.view.csrfToken),
        body: JSON.stringify({ hostId: otherId, clientId: id }),
      })
    expect((await issue(otherId)).status).toBe(403)
    expect((await issue(clientId)).status).toBe(404)
    expect(f.deps.supabase.rpc).toHaveBeenCalledWith('control_grant_issue', {
      p_user: userId,
      p_host: otherId,
      p_client: clientId,
      p_sid: sid,
    })
    const keyset = await f.app.request(origin + '/api/v1/grant-keys', {
      headers: { cookie: l.sealed },
    })
    expect(keyset.status).toBe(200)
    expect(keyset.headers.get('set-cookie')).toBeNull()
    expect(keyset.headers.get('cache-control')).toBe('public, max-age=300')
    const clients = await f.app.request(origin + '/api/v1/clients', {
      headers: { cookie: l.sealed },
    })
    expect(clients.status).toBe(200)
    f.revoke()
    for (const path of ['/api/auth/session', '/api/v1/me', '/api/v1/clients']) {
      expect((await f.app.request(origin + path, { headers: { cookie: l.sealed } })).status).toBe(
        401,
      )
      expect(
        (await createApp(f.deps).request(origin + path, { headers: { cookie: l.sealed } })).status,
      ).toBe(401)
    }
  })
  it('clears locally, revokes only this device and Auth session, and refuses old cookies after restart', async () => {
    const f = fixture(),
      l = await f.login()
    const res = await f.app.request(origin + '/api/auth/signout', {
      method: 'POST',
      headers: mutationHeaders(l.sealed, l.view.csrfToken),
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ signedOut: true, remoteCleanup: 'complete' })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(f.deps.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/logout?scope=local'),
      expect.anything(),
    )
    expect(
      (
        await createApp(f.deps).request(origin + '/api/auth/session', {
          headers: { cookie: l.sealed },
        })
      ).status,
    ).toBe(401)
  })
  it('reports pending when remote cleanup is unavailable, without promising durable logout', async () => {
    const f = fixture(),
      l = await f.login()
    f.outage()
    const res = await f.app.request(origin + '/api/auth/signout', {
      method: 'POST',
      headers: mutationHeaders(l.sealed, l.view.csrfToken),
      body: '{}',
    })
    expect(await res.json()).toEqual({ signedOut: true, remoteCleanup: 'pending' })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(
      (
        await createApp(f.deps).request(origin + '/api/auth/session', {
          headers: { cookie: l.sealed },
        })
      ).status,
    ).toBeGreaterThanOrEqual(500)
  })
  it('refuses a refreshed cookie delivered late after durable logout, in a new process', async () => {
    const f = fixture(),
      l = await f.login()
    f.advance()
    const refresh = await f.app.request(origin + '/api/auth/session', {
      headers: { cookie: l.sealed },
    })
    expect(refresh.status).toBe(200)
    const lateCookie = cookie(refresh, cookieName)
    const logout = await f.app.request(origin + '/api/auth/signout', {
      method: 'POST',
      headers: mutationHeaders(l.sealed, l.view.csrfToken),
      body: '{}',
    })
    expect(logout.status).toBe(200)
    expect(
      (
        await createApp(f.deps).request(origin + '/api/auth/session', {
          headers: { cookie: lateCookie },
        })
      ).status,
    ).toBe(401)
  })
  it('expires the sealed session absolutely and clears invalid cookies for a new sign-in', async () => {
    const f = fixture(),
      l = await f.login()
    for (let i = 0; i < 1235; i++) f.advance()
    const res = await f.app.request(origin + '/api/auth/session', { headers: { cookie: l.sealed } })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
  it('uses distinct insecure development cookie names only for explicit literal loopback', async () => {
    const f = fixture()
    f.deps.config = parseConfig({ ...f.env, CONTROL_WEB_ORIGIN: 'http://127.0.0.1:5015' })
    const res = await createApp(f.deps).request('http://127.0.0.1:5015/api/auth/start')
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('phosphor-dev-transaction=')
    expect(res.headers.get('set-cookie')).not.toContain('Secure')
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
  })
  it('does not revive a client when logout wins a race with refresh', async () => {
    const f = fixture(),
      l = await f.login()
    f.advance()
    let release!: () => void
    f.delay(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const pending = f.app.request(origin + '/api/auth/session', { headers: { cookie: l.sealed } })
    await vi.waitFor(() =>
      expect(
        vi.mocked(f.deps.fetch).mock.calls.some(([url]) => String(url).includes('refresh_token')),
      ).toBe(true),
    )
    const logout = await f.app.request(origin + '/api/auth/signout', {
      method: 'POST',
      headers: mutationHeaders(l.sealed, l.view.csrfToken),
      body: '{}',
    })
    expect(logout.status).toBe(200)
    release()
    const late = await pending
    expect(late.status).toBe(401)
    expect(late.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})
