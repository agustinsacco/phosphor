import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createApp } from './app'
import { dependencies, token, userId } from './test-support'
import { parseConfig } from './config'
import { ControlFailure, type Env } from './http'
import { createUserAuth, userGuard } from './auth/user'
import { RateLimiter } from './limits'

const headers = { 'content-type': 'application/json' }
describe('API envelope', () => {
  it('sets JSON security headers and safe request ids on every outcome', async () => {
    const app = createApp(dependencies())
    for (const [path, method, status] of [
      ['/health', 'GET', 200],
      ['/me', 'GET', 401],
      ['/missing', 'GET', 404],
      ['/health', 'POST', 405],
      ['/health', 'HEAD', 405],
      ['/missing', 'OPTIONS', 405],
    ] as const) {
      const res = await app.request(`/api/v1${path}`, {
        method,
        ...(method === 'POST' ? { headers, body: '{}' } : {}),
      })
      expect(res.status).toBe(status)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      )
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/)
      expect([...res.headers.keys()].some((key) => key.startsWith('access-control-'))).toBe(false)
      if (status !== 200 && method !== 'HEAD')
        expect(await res.json()).toEqual({
          error: {
            code: status === 405 ? 'bad-request' : status === 401 ? 'unauthenticated' : 'not-found',
            message: expect.any(String),
          },
        })
    }
  })
  it('counts bytes, including lying Content-Length and chunked bodies, at the exact limit', async () => {
    const app = createApp(dependencies())
    const body = JSON.stringify('x'.repeat(16382))
    expect((await app.request('/api/v1/missing', { method: 'POST', headers, body })).status).toBe(
      404,
    )
    for (const extra of [
      new Headers(headers),
      new Headers({ ...headers, 'content-length': '1' }),
      new Headers({ ...headers, 'transfer-encoding': 'chunked' }),
    ]) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(body))
          c.enqueue(new Uint8Array([32]))
          c.close()
        },
      })
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers: extra,
        body: stream,
        duplex: 'half',
      }
      const request = new Request('http://localhost/api/v1/missing', init)
      expect((await app.request(request)).status).toBe(413)
    }
    expect((await app.request('/api/v1/missing', { method: 'POST', body: '{}' })).status).toBe(415)
    expect(
      (await app.request('/api/v1/missing', { method: 'POST', headers, body: '{' })).status,
    ).toBe(400)
    expect(
      (
        await app.request('/api/v1/missing', {
          method: 'POST',
          headers,
          body: new Uint8Array([0xff]),
        })
      ).status,
    ).toBe(400)
  })
  it('does not require Supabase for health; other routes fail closed', async () => {
    const deps = dependencies()
    deps.config = parseConfig({})
    const app = createApp(deps)
    expect(await (await app.request('/api/v1/health')).json()).toEqual({
      ok: true,
      version: 'test',
      configured: false,
    })
    expect((await app.request('/api/v1/me')).status).toBe(503)
    expect((await app.request('/healthz')).status).toBe(200)
    expect(deps.supabase.getUser).not.toHaveBeenCalled()
  })
  it('never logs headers, body, tokens, codes, keys or concrete unknown paths', async () => {
    const deps = dependencies()
    const secret = randomBytes(32).toString('hex')
    const code = 'BCDF-GHJK'
    await createApp(deps).request(`/api/v1/${secret}`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${secret}`, 'x-phosphor-signature': secret },
      body: JSON.stringify({ userCode: code }),
    })
    const logs = JSON.stringify(vi.mocked(deps.log).mock.calls)
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain(code)
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'anon', route: 'unmatched', status: 404 }),
    )
  })
})
describe('User auth', () => {
  it('rejects malformed, oversized, expired and wrong-audience tokens before Auth', async () => {
    const deps = dependencies()
    const consume = vi.spyOn(deps.limits, 'consume')
    const app = createApp(deps)
    for (const authorization of [
      '',
      'Bearer garbage',
      'Bearer ' + 'x'.repeat(4097),
      `Bearer ${token(deps.clock() / 1000)}`,
      `Bearer ${token(deps.clock() / 1000 + 100, 'other')}`,
      'Bearer e30.eA.c2ln',
    ]) {
      expect((await app.request('/api/v1/me', { headers: { authorization } })).status).toBe(401)
    }
    expect(deps.supabase.getUser).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
  })
  it('maps Auth failures; does not cache failure or malformed users or RPC output', async () => {
    const deps = dependencies()
    const app = createApp(deps)
    const authorization = `Bearer ${token(deps.clock() / 1000 + 100)}`
    for (const code of ['unauthenticated', 'unavailable'] as const) {
      vi.mocked(deps.supabase.getUser).mockRejectedValueOnce(new ControlFailure(code))
      expect((await app.request('/api/v1/me', { headers: { authorization } })).status).toBe(
        code === 'unauthenticated' ? 401 : 503,
      )
    }
    vi.mocked(deps.supabase.getUser).mockResolvedValueOnce({ id: 'not-a-uuid' })
    expect((await app.request('/api/v1/me', { headers: { authorization } })).status).toBe(503)
    vi.mocked(deps.supabase.rpc).mockResolvedValueOnce({ enabled: true, maxHosts: -1 })
    expect((await app.request('/api/v1/me', { headers: { authorization } })).status).toBe(503)
    expect((await app.request('/api/v1/me', { headers: { authorization } })).status).toBe(200)
  })
  it('caches only 30 seconds, never beyond expiry; upserts/checks account every time', async () => {
    const deps = dependencies()
    let now = deps.clock()
    deps.clock = () => now
    const app = createApp(deps)
    const authorization = `Bearer ${token(now / 1000 + 31)}`
    expect((await app.request('/api/v1/me', { headers: { authorization } })).status).toBe(200)
    now += 29_999
    await app.request('/api/v1/me', { headers: { authorization } })
    expect(deps.supabase.getUser).toHaveBeenCalledTimes(1)
    now++
    await app.request('/api/v1/me', { headers: { authorization } })
    expect(deps.supabase.getUser).toHaveBeenCalledTimes(2)
    now += 1000
    expect((await app.request('/api/v1/me', { headers: { authorization } })).status).toBe(401)
    expect(deps.supabase.getUser).toHaveBeenCalledTimes(2)
    expect(deps.supabase.rpc).toHaveBeenCalledTimes(3)
    expect(deps.supabase.rpc).toHaveBeenCalledWith('control_account', {
      p_user_id: userId,
      p_login: 'tester',
    })
  })
  it('allows /me for suspended accounts and denies a test-only guarded route', async () => {
    const deps = dependencies()
    vi.mocked(deps.supabase.rpc).mockResolvedValue({ enabled: false, maxHosts: 20 })
    const app = createApp(deps)
    const auth = createUserAuth(deps.supabase, deps.clock, deps.limits)
    // The catch-all belongs last, so test the exported guard in a separate app.
    const { Hono } = await import('hono')
    const guarded = new Hono<Env>()
    guarded.onError(
      (e) => new Response(null, { status: e instanceof ControlFailure ? e.status : 500 }),
    )
    guarded.get('/guarded', userGuard(auth, deps.supabase), (c) => c.json(c.get('user')))
    const authorization = `Bearer ${token(deps.clock() / 1000 + 100)}`
    expect(await (await app.request('/api/v1/me', { headers: { authorization } })).json()).toEqual({
      account: { login: 'tester' },
      enabled: false,
      maxHosts: 20,
    })
    vi.mocked(deps.supabase.rpc).mockResolvedValueOnce({ enabled: true, maxHosts: 20 })
    const enabled = await guarded.request('/guarded', { headers: { authorization } })
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toEqual({ userId, login: 'tester' })
    expect((await guarded.request('/guarded', { headers: { authorization } })).status).toBe(403)
  })
  it('bounds the success cache at 1000 identities', async () => {
    const deps = dependencies()
    const auth = createUserAuth(deps.supabase, deps.clock, deps.limits)
    for (let i = 0; i <= 1000; i++)
      await auth(`Bearer ${token(deps.clock() / 1000 + 100 + i)}`, `ip:${i}`)
    await auth(`Bearer ${token(deps.clock() / 1000 + 100)}`, '127.0.0.1')
    expect(deps.supabase.getUser).toHaveBeenCalledTimes(1002)
  })
})

it('stores only token hashes and rejects tokens that expire during Auth validation', async () => {
  const { BoundedCache } = await import('./limits')
  const { createHash } = await import('node:crypto')
  const deps = dependencies()
  let now = deps.clock()
  deps.clock = () => now
  const auth = createUserAuth(deps.supabase, deps.clock, deps.limits)
  const bearer = token(now / 1000 + 1)
  const set = vi.spyOn(BoundedCache.prototype, 'set')
  try {
    await auth(`Bearer ${bearer}`, '127.0.0.1')
    expect(set).toHaveBeenCalledWith(
      createHash('sha256').update(bearer).digest('hex'),
      expect.any(Object),
      now + 1000,
    )
  } finally {
    set.mockRestore()
  }
  now += 1000
  const next = token(now / 1000 + 1)
  vi.mocked(deps.supabase.getUser).mockImplementationOnce(async () => {
    now += 1000
    return { id: userId }
  })
  await expect(auth(`Bearer ${next}`, '127.0.0.1')).rejects.toMatchObject({
    code: 'unauthenticated',
  })
})

it('enforces the JWT size boundary before calling Auth', async () => {
  const deps = dependencies()
  const auth = createUserAuth(deps.supabase, deps.clock, deps.limits)
  const parts = token(deps.clock() / 1000 + 100).split('.')
  const suffix = `.${parts[1]}.${parts[2]}`
  const exact = 'A'.repeat(4096 - suffix.length) + suffix
  await expect(auth(`Bearer ${exact}`, '127.0.0.1')).resolves.toEqual({ userId, login: 'tester' })
  await expect(auth(`Bearer A${exact}`, '127.0.0.1')).rejects.toMatchObject({
    code: 'unauthenticated',
  })
  expect(deps.supabase.getUser).toHaveBeenCalledTimes(1)
})

it('limits user verification misses per IP, with cache hits and pre-check failures free', async () => {
  const deps = dependencies()
  let now = deps.clock()
  deps.clock = () => now
  deps.limits = new RateLimiter(deps.clock)
  const edgeSecret = randomBytes(32).toString('base64url')
  deps.config = parseConfig({
    CONTROL_TRUST_PROXY: 'cloudflare',
    CONTROL_EDGE_SECRET: edgeSecret,
    SUPABASE_SECRET_KEY: randomBytes(32).toString('hex'),
  })
  const app = createApp(deps)
  const call = (n: number, ip = '192.0.2.1') =>
    app.request('/api/v1/me', {
      headers: {
        authorization: `Bearer ${token(deps.clock() / 1000 + 100 + n)}`,
        'cf-connecting-ip': ip,
        'x-phosphor-edge': edgeSecret,
      },
    })
  for (let i = 0; i < 31; i++) {
    expect(
      (
        await app.request('/api/v1/me', {
          headers: {
            authorization: 'Bearer garbage',
            'cf-connecting-ip': '192.0.2.1',
            'x-phosphor-edge': edgeSecret,
          },
        })
      ).status,
    ).toBe(401)
  }
  expect((await call(0)).status).toBe(200)
  for (let i = 0; i < 31; i++) expect((await call(0)).status).toBe(200)
  for (let i = 1; i < 30; i++) expect((await call(i)).status).toBe(200)
  expect((await call(30)).status).toBe(429)
  expect(deps.supabase.getUser).toHaveBeenCalledTimes(30)
  expect((await call(30, '192.0.2.2')).status).toBe(200)
  expect(deps.supabase.getUser).toHaveBeenCalledTimes(31)
  now += 60_000
  expect((await call(31)).status).toBe(200)
  expect(deps.supabase.getUser).toHaveBeenCalledTimes(32)
  // Without edge authentication different forwarded IPs share the socket bucket.
  for (let i = 0; i < 31; i++) {
    const response = await app.request('/api/v1/me', {
      headers: {
        authorization: `Bearer ${token(deps.clock() / 1000 + 200 + i)}`,
        'cf-connecting-ip': `192.0.2.${i + 1}`,
        ...(i % 2 ? { 'x-phosphor-edge': randomBytes(32).toString('base64url') } : {}),
      },
    })
    expect(response.status).toBe(i < 30 ? 200 : 429)
  }
  const logs = JSON.stringify(vi.mocked(deps.log).mock.calls)
  expect(logs).not.toContain('192.0.2.')
  expect(logs).not.toContain(edgeSecret)
  expect(logs).not.toContain('x-phosphor-edge')
})

it('suppresses probes, classifies static requests, and never reflects malformed trace headers', async () => {
  const deps = dependencies()
  const app = createApp(deps)
  for (const path of ['/healthz', '/api/v1/health', '/']) {
    await app.request(path, { headers: { 'user-agent': 'kube-probe/1.0' } })
  }
  await app.request('/healthz')
  expect(deps.log).not.toHaveBeenCalled()
  for (const [client, trace] of [
    ['host/1 secret', '0'.repeat(16)],
    ['host/1', 'A'.repeat(16)],
    ['host/' + '1'.repeat(41), '0'.repeat(16)],
  ] as const) {
    await app.request('/api/v1/me', {
      headers: { 'x-phosphor-client': client, 'x-phosphor-trace': trace },
    })
    expect(deps.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ client: 'invalid', error: 'unauthenticated', status: 401 }),
    )
  }
  const accepted = await app.request('/api/v1/me', {
    headers: {
      authorization: `Bearer ${token(deps.clock() / 1000 + 100)}`,
      'x-phosphor-client': 'host/1 secret',
      'x-phosphor-trace': 'A'.repeat(16),
    },
  })
  expect(accepted.status).toBe(200)
  expect(deps.log).toHaveBeenLastCalledWith(
    expect.objectContaining({ client: 'invalid', trace: null, error: null, status: 200 }),
  )
  expect(deps.supabase.getUser).toHaveBeenCalledTimes(1)
  await app.request('/')
  expect(deps.log).toHaveBeenLastCalledWith(
    expect.objectContaining({ route: 'site', pathClass: 'page' }),
  )
  await app.request('/_astro/app.js')
  expect(deps.log).toHaveBeenLastCalledWith(
    expect.objectContaining({ route: 'site', pathClass: 'asset' }),
  )
  const text = JSON.stringify(vi.mocked(deps.log).mock.calls)
  expect(text).not.toContain('host/1 secret')
  expect(text).not.toContain('A'.repeat(16))
})
