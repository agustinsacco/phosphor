import { describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  CONTROL_ROUTES as R,
  formatKeyFingerprint,
  parseEnrollmentCreateResponse,
  parseControlError,
  type Parsed,
} from '@phosphor/shared/control-api'
import { createApp } from '../../app'
import { dependencies, signingKey, token, userId } from '../../test-support'
import { RateLimiter } from '../../limits'
import { parseConfig } from '../../config'

export const date = '2026-10-12T12:00:00.000Z'
export const machine = {
  id: userId,
  label: 'bee',
  hostname: 'bee',
  platform: 'linux',
  arch: 'x64',
  hostVersion: '1.0.0',
  keyFingerprint: '1234-5678-90ab-cdef',
  enrolledAt: date,
  lastSeenAt: null,
  state: null,
  readiness: null,
  lanes: null,
  endpoint: null,
}
export const heartbeat = {
  seq: 1,
  state: 'running',
  hostVersion: '1.0.0',
  uptimeSec: 1,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  lanes: { running: 0, waiting: 0 },
  endpoint: null,
}
export function setup() {
  const deps = dependencies()
  const key = signingKey()
  let now = deps.clock()
  deps.clock = () => now
  deps.limits = new RateLimiter(deps.clock)
  const results: Record<string, unknown> = {
    control_account: { enabled: true, maxHosts: 20 },
    control_host_key: { outcome: 'active', publicKey: key.publicKey },
    control_host_revocations: { epoch: 1, ownerId: userId, revoked: { sessions: [], clients: [] } },
  }
  vi.mocked(deps.supabase.rpc).mockImplementation(async (name) => results[name])
  const app = createApp(deps)
  const call = (
    path: string,
    method: string,
    value?: unknown,
    mode: 'user' | 'key' | 'host' = 'user',
  ) =>
    mode === 'user'
      ? app.request(path, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token(Math.floor(now / 1000) + 100)}`,
          },
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        })
      : app.request(key.request(method, path, value, now, mode === 'host' ? userId : undefined))
  return {
    deps,
    key,
    results,
    app,
    call,
    advance: (ms: number) => {
      now += ms
    },
  }
}

interface RouteCase {
  path: string
  method: string
  mode: 'user' | 'key' | 'host'
  rpc: string
  value: object | undefined
  answer: object
  parser: ((value: unknown) => Parsed<unknown>) | null
  outcomes: Readonly<Record<string, number>>
}
function input(route: RouteCase, s: ReturnType<typeof setup>) {
  return route.path === R.enrollments ? { ...route.value, publicKey: s.key.publicKey } : route.value
}
function successCases(route: RouteCase) {
  it('returns exactly the parsed contract and sets the authenticated actor', async () => {
    const s = setup()
    s.results[route.rpc] = { ...route.answer, extra: randomBytes(32).toString('hex') }
    const res = await s.call(route.path, route.method, input(route, s), route.mode)
    expect(res.status).toBe(route.parser ? 200 : 204)
    if (route.parser) {
      const value = await res.json()
      const result = route.parser(value)
      expect(result.ok).toBe(true)
      if (result.ok) expect(value).toEqual(result.value)
      if (route.path === R.enrollments) {
        const created = parseEnrollmentCreateResponse(value)
        if (!created.ok) throw new Error('invalid create response')
        expect(
          created.value.keyFingerprint ===
            formatKeyFingerprint(
              createHash('sha256').update(Buffer.from(s.key.publicKey, 'base64url')).digest(),
            ),
        ).toBe(true)
      }
    } else expect(await res.text()).toBe('')
    expect(s.deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: route.mode === 'key' ? 'anon' : route.mode + ':' + userId,
      }),
    )
  })
  for (const [outcome, status] of Object.entries(route.outcomes))
    it('maps ' + outcome, async () => {
      const s = setup()
      s.results[route.rpc] = { outcome }
      const res = await s.call(route.path, route.method, input(route, s), route.mode)
      expect(res.status).toBe(status)
      expect(parseControlError(await res.json())).not.toBeNull()
    })
}
function failureCases(route: RouteCase) {
  it('fails closed on malformed RPC output', async () => {
    const s = setup()
    s.results[route.rpc] = { outcome: 'unexpected' }
    expect((await s.call(route.path, route.method, input(route, s), route.mode)).status).toBe(503)
    s.advance(2000)
    s.results[route.rpc] = {
      outcome: route.answer && 'outcome' in route.answer ? route.answer.outcome : undefined,
    }
    if (
      route.parser &&
      route.rpc !== 'control_host_heartbeat' &&
      route.rpc !== 'control_enrollment_poll'
    )
      expect((await s.call(route.path, route.method, input(route, s), route.mode)).status).toBe(503)
  })
  it('refuses unauthenticated, unconfigured, incorrect methods and framed bodies', async () => {
    const s = setup()
    s.results[route.rpc] = route.answer
    expect(
      (
        await s.app.request(route.path, {
          method: route.method,
          headers: { 'content-type': 'application/json' },
          ...(input(route, s) === undefined ? {} : { body: JSON.stringify(input(route, s)) }),
        })
      ).status,
    ).toBe(401)
    s.deps.config = parseConfig({})
    expect((await s.call(route.path, route.method, input(route, s), route.mode)).status).toBe(503)
    s.deps.config = dependencies().config
    const wrong = await s.app.request(route.path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe(
      route.path.startsWith(R.machines + '/') ? 'PATCH, DELETE' : route.method,
    )
    if (input(route, s) !== undefined) {
      expect((await s.app.request(route.path, { method: route.method, body: '{}' })).status).toBe(
        415,
      )
      expect((await s.call(route.path, route.method, null, route.mode)).status).toBe(400)
      expect((await s.call(route.path, route.method, 'x'.repeat(16384), route.mode)).status).toBe(
        413,
      )
    } else {
      expect(
        (
          await s.app.request(route.path, {
            method: route.method,
            headers: { 'content-length': '1' },
          })
        ).status,
      ).toBe(400)
    }
  })
}
function disabledAccountCase(route: RouteCase) {
  if (route.mode === 'user')
    it('refuses disabled accounts on every request', async () => {
      const s = setup()
      s.results.control_account = { enabled: false, maxHosts: 20 }
      expect((await s.call(route.path, route.method, input(route, s))).status).toBe(403)
      expect(s.deps.supabase.rpc).not.toHaveBeenCalledWith(route.rpc, expect.anything())
    })
}
export function routeContracts(routes: readonly RouteCase[]) {
  for (const route of routes)
    describe(route.path + ' ' + route.method, () => {
      successCases(route)
      failureCases(route)
      disabledAccountCase(route)
    })
}
