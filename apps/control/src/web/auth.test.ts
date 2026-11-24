import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { ControlFailure } from '../http'
import { parseConfig } from '../config'
import { token, userId } from '../test-support'
import {
  HOUR,
  clientId,
  cookie,
  cookieName,
  fixture,
  mutationHeaders,
  origin,
  otherId,
  sid,
  transactionName,
} from './test-fixture'

const failed = (res: Response, code: string) => {
  expect(res.status).toBe(303)
  expect(res.headers.get('location')).toBe(`/?signin-error=${code}`)
}
const session = (f: ReturnType<typeof fixture>, value: string, app = f.app) =>
  app.request(origin + '/api/auth/session', { headers: { cookie: value } })

describe('browser sign-in', () => {
  it('binds PKCE to a sealed transaction and keeps only a random handle in the cookie', async () => {
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
    expect(login.res.headers.get('set-cookie')).toContain(`Max-Age=${90 * 86_400}`)
    expect(login.view).toEqual({
      user: { id: userId, login: 'tester' },
      clientId,
      csrfToken: expect.stringMatching(/^[\w-]{43}$/),
    })
    const handle = login.session.slice(cookieName.length + 1)
    expect(handle).toMatch(/^[\w-]{43}$/)
    const hash = createHash('sha256').update(handle).digest('hex')
    expect(f.deps.supabase.rpc).toHaveBeenCalledWith('control_web_session_create', {
      p_user: userId,
      p_login: 'tester',
      p_sid: sid,
      p_handle_hash: hash,
    })
    // Neither the database nor the logs ever see the handle or a provider token.
    const exposed = JSON.stringify([
      login.view,
      vi.mocked(f.deps.log).mock.calls,
      vi.mocked(f.deps.supabase.rpc).mock.calls,
    ])
    expect(exposed).not.toContain(handle)
    expect(exposed).not.toMatch(/refresh-secret|DISCARD-GITHUB|short-lived-code|e30\./)
  })
  it('sends tampered, expired, mismatched and replayed sign-ins back to the app with a code', async () => {
    for (const mode of ['tampered', 'expired', 'state', 'missing', 'replay']) {
      const f = fixture(),
        s = await f.start()
      let transaction = s.transaction
      if (mode === 'tampered') transaction += 'x'
      if (mode === 'expired') f.advance(600_001)
      if (mode === 'state') s.callback.searchParams.set('state', 'a'.repeat(43))
      if (mode === 'missing') transaction = ''
      if (mode === 'replay')
        await f.app.request(s.callback.href, { headers: { cookie: transaction } })
      const res = await f.app.request(s.callback.href, { headers: { cookie: transaction } })
      failed(res, 'unauthenticated')
      expect(await res.text()).not.toContain('short-lived-code')
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(new RegExp(`${cookieName}=[\\w-]`))
    }
  })
  it('refuses unsafe return paths, cross-site start and a wrong or forwarded host', async () => {
    const f = fixture()
    for (const path of ['//evil.test', '/api/auth/session', '/\\evil', '/ok?token=x', '/%2f%2fe'])
      failed(
        await f.app.request(origin + '/api/auth/start?returnTo=' + encodeURIComponent(path)),
        'bad-request',
      )
    failed(
      await f.app.request(origin + '/api/auth/start', {
        headers: { 'sec-fetch-site': 'same-site' },
      }),
      'forbidden',
    )
    const wrong = await f.app.request('https://evil.test/api/auth/start', {
      headers: { 'x-forwarded-host': new URL(origin).host },
    })
    expect(wrong.status).toBe(404)
    expect(wrong.headers.get('location')).toBeNull()
    expect(
      (await f.app.request(origin + '/api/auth/start', { headers: { host: 'evil.test' } })).status,
    ).toBe(404)
  })
  it('returns a signed-in browser home instead of starting or finishing another sign-in', async () => {
    const f = fixture(),
      l = await f.login()
    const again = await f.app.request(origin + '/api/auth/start?returnTo=/lanes', {
      headers: { cookie: l.session },
    })
    expect(again.status).toBe(303)
    expect(again.headers.get('location')).toBe('/lanes')
    expect(again.headers.get('set-cookie')).toBeNull()
    const s = await f.start()
    const back = await f.app.request(s.callback.href, {
      headers: { cookie: `${s.transaction}; ${l.session}` },
    })
    expect(back.headers.get('location')).toBe('/machines')
    expect(cookie(back, transactionName)).toBe(`${transactionName}=`)
    expect(f.sessions.size).toBe(1)
  })
  it('sends an outage and a disabled account to the app without diagnostics', async () => {
    const f = fixture(),
      s = await f.start()
    f.outage()
    const res = await f.app.request(s.callback.href, { headers: { cookie: s.transaction } })
    failed(res, 'unavailable')
    expect(await res.text()).not.toContain('secret')
    const g = fixture()
    g.disable()
    const t = await g.start()
    failed(
      await g.app.request(t.callback.href, { headers: { cookie: t.transaction } }),
      'forbidden',
    )
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
})

describe('browser session', () => {
  it('requires both exact Origin and the session CSRF token for mutations', async () => {
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
        headers: { ...mutationHeaders(l.session, csrf!), origin: requestOrigin! },
        body: '{}',
      })
      expect(res.status).toBe(403)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect(f.sessions.size).toBe(1)
  })
  it('keeps the site bearer-only and refuses a bearer on the app', async () => {
    const f = fixture(),
      l = await f.login()
    const site = (headers: Record<string, string>) =>
      f.app.request('https://phosphor.example.test/api/v1/me', { headers })
    expect((await site({ cookie: l.session })).status).toBe(401)
    const bearer = `Bearer ${token(f.deps.clock() / 1000 + 100)}`
    expect((await site({ cookie: l.session, authorization: bearer })).status).toBe(200)
    expect(
      (
        await f.app.request(origin + '/api/auth/session', {
          headers: { cookie: l.session, authorization: 'Bearer anything' },
        })
      ).status,
    ).toBe(400)
  })
  it('clears an unknown or old-format cookie without asking the database about junk', async () => {
    const f = fixture()
    for (const value of ['first.c2VhbGVk', 'x'.repeat(43), 'invalid']) {
      const res = await session(f, `${cookieName}=${value}`)
      expect(res.status, value).toBe(401)
      expect(res.headers.get('set-cookie')).toContain(`${cookieName}=; Path=/`)
    }
    expect(vi.mocked(f.deps.supabase.rpc).mock.calls.map(([name]) => name)).toEqual([
      'control_web_session_use',
    ])
  })
  it('survives restarts, replicas and a sealing-key rotation: nothing lives in memory', async () => {
    const f = fixture(),
      l = await f.login()
    f.deps.config = parseConfig({
      ...f.env,
      CONTROL_WEB_SESSION_KEYS: `second=${randomBytes(32).toString('base64url')}`,
    })
    const res = await session(f, l.session, createApp(f.deps))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('slides: each hour of use renews the same handle for another 90 days', async () => {
    const f = fixture(),
      l = await f.login()
    for (let day = 0; day < 200; day += 30) {
      f.advance(30 * 24 * HOUR)
      const res = await session(f, l.session)
      expect(res.status).toBe(200)
      expect(cookie(res, cookieName)).toBe(l.session)
      expect(res.headers.get('set-cookie')).toContain(`Max-Age=${90 * 86_400}`)
    }
    f.advance(10 * 60_000)
    expect((await session(f, l.session)).headers.get('set-cookie')).toBeNull()
  })
  it('ends after 90 idle days, a revoked device or an ended Supabase session', async () => {
    for (const end of ['idle', 'revoked', 'supabase'] as const) {
      const f = fixture(),
        l = await f.login()
      if (end === 'idle') f.advance(90 * 24 * HOUR + 1)
      if (end === 'revoked') f.revoke()
      if (end === 'supabase') f.endSupabaseSession()
      for (const path of ['/api/auth/session', '/api/v1/me', '/api/v1/clients']) {
        const res = await f.app.request(origin + path, { headers: { cookie: l.session } })
        expect(res.status, `${end} ${path}`).toBe(401)
      }
    }
  })
  it('refuses a disabled account without forgetting the browser', async () => {
    const f = fixture(),
      l = await f.login()
    f.disable()
    const res = await session(f, l.session)
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('pins grants to this browser and its Supabase session, and refuses client registration', async () => {
    const f = fixture(),
      l = await f.login()
    const post = (path: string, body: unknown) =>
      f.app.request(origin + path, {
        method: 'POST',
        headers: mutationHeaders(l.session, l.view.csrfToken),
        body: JSON.stringify(body),
      })
    expect((await post('/api/v1/clients', { label: 'bypass' })).status).toBe(403)
    expect((await post('/api/v1/grants', { hostId: otherId, clientId: otherId })).status).toBe(403)
    expect((await post('/api/v1/grants', { hostId: otherId, clientId })).status).toBe(404)
    expect(f.deps.supabase.rpc).toHaveBeenCalledWith('control_grant_issue', {
      p_user: userId,
      p_host: otherId,
      p_client: clientId,
      p_sid: sid,
    })
    const keyset = await f.app.request(origin + '/api/v1/grant-keys', {
      headers: { cookie: l.session },
    })
    expect(keyset.status).toBe(200)
    expect(keyset.headers.get('set-cookie')).toBeNull()
    expect(keyset.headers.get('cache-control')).toBe('public, max-age=300')
  })
  it('signs out for good: ends the session server-side and clears the cookie', async () => {
    const f = fixture(),
      l = await f.login()
    const out = await f.app.request(origin + '/api/auth/signout', {
      method: 'POST',
      headers: mutationHeaders(l.session, l.view.csrfToken),
      body: '{}',
    })
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ signedOut: true, remoteCleanup: 'complete' })
    expect(out.headers.get('set-cookie')).toContain(`${cookieName}=; Path=/`)
    expect(f.sessions.size).toBe(0)
    expect((await session(f, l.session, createApp(f.deps))).status).toBe(401)
  })
  it('keeps the session when sign-out cannot reach the database', async () => {
    const f = fixture(),
      l = await f.login()
    const ended = vi.mocked(f.deps.supabase.rpc).getMockImplementation()!
    vi.mocked(f.deps.supabase.rpc).mockImplementation(async (name, args) => {
      if (name === 'control_web_session_end') throw new ControlFailure('unavailable')
      return ended(name, args)
    })
    const out = await f.app.request(origin + '/api/auth/signout', {
      method: 'POST',
      headers: mutationHeaders(l.session, l.view.csrfToken),
      body: '{}',
    })
    expect(out.status).toBe(503)
    expect(out.headers.get('set-cookie')).toBeNull()
    expect((await session(f, l.session)).status).toBe(200)
  })
})
