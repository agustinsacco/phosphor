import { randomBytes, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { CONTROL_ROUTES as R } from '@phosphor/shared/control-api'
import { createApp } from '../app'
import { parseConfig } from '../config'
import { dependencies, signingKey } from '../test-support'

/** Keys each rate-limit purpose may hold; test-support wires the production limiter. */
const purposeCapacity = 10_000
const edgeSecret = randomBytes(32).toString('base64url')

function setup() {
  const deps = dependencies()
  deps.config = parseConfig({
    SUPABASE_SECRET_KEY: randomBytes(32).toString('hex'),
    CONTROL_TRUST_PROXY: 'cloudflare',
    CONTROL_EDGE_SECRET: edgeSecret,
    CONTROL_GRANT_KEYS: `current=${randomBytes(32).toString('base64url')}`,
  })
  const hostKey = signingKey()
  const hostId = randomUUID()
  const client = { id: randomUUID(), label: 'Desktop' }
  const results: Record<string, unknown> = {
    control_account: { enabled: true, maxHosts: 20 },
    control_client_register: { outcome: 'registered', client },
    control_grant_issue: {
      outcome: 'issued',
      epoch: 1,
      publicKey: hostKey.publicKey,
      endpoint: 'https://bee.ts.net',
      client,
    },
    control_host_key: { outcome: 'active', publicKey: hostKey.publicKey },
    control_host_self: {
      outcome: 'active',
      hostId,
      label: 'bee',
      owner: { login: 'tester' },
      enrolledAt: '2026-10-12T12:00:00.000Z',
      lastSeenAt: null,
    },
  }
  vi.mocked(deps.supabase.rpc).mockImplementation(async (name) => results[name])
  const app = createApp(deps)
  /** Every request arrives through the authenticated edge, from `ip`. */
  const from = (ip: string, request: Request) => {
    request.headers.set('cf-connecting-ip', ip)
    request.headers.set('x-phosphor-edge', edgeSecret)
    return app.request(request)
  }
  const post = (path: string, value: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    })
  /** A token the verification cache has never seen, so each call verifies upstream. */
  const freshToken = () =>
    `e30.${Buffer.from(
      JSON.stringify({
        exp: deps.clock() / 1000 + 600,
        aud: 'authenticated',
        session_id: randomUUID(),
      }),
    ).toString('base64url')}.c2ln`
  return {
    deps,
    enroll: (ip: string) => from(ip, post(R.enrollments, {})),
    me: (ip: string) =>
      from(
        ip,
        new Request('http://localhost' + R.me, {
          headers: { authorization: `Bearer ${freshToken()}` },
        }),
      ),
    issueGrant: (ip: string) =>
      from(
        ip,
        post(
          R.grants,
          { hostId, clientId: client.id },
          { authorization: `Bearer ${freshToken()}` },
        ),
      ),
    registerClient: (ip: string) =>
      from(ip, post(R.clients, { label: 'Desktop' }, { authorization: `Bearer ${freshToken()}` })),
    hostSelf: (ip: string) =>
      from(ip, hostKey.request('GET', R.hostSelf, undefined, deps.clock(), hostId)),
  }
}
/** The i-th of `purposeCapacity` distinct /64 networks. */
const subnet = (i: number) => `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}`

it('confines an unauthenticated enrollment flood from distinct /64s to enrollment creates', async () => {
  const s = setup()
  // Each create spends its address's key before the request body is even parsed.
  for (let i = 0; i < purposeCapacity; i++)
    expect((await s.enroll(`${subnet(i)}::1`)).status).toBe(400)
  // Same purpose: a new /64 is refused, and the live windows are kept rather than evicted.
  expect((await s.enroll('2001:db8:ffff:0::1')).status).toBe(429)
  for (let i = 1; i < 10; i++) expect((await s.enroll(`${subnet(0)}::1`)).status).toBe(400)
  expect((await s.enroll(`${subnet(0)}::1`)).status).toBe(429)
  // Other purposes keep their own capacity: new, uncached callers still get through.
  expect((await s.me('2001:db8:ffff:1::1')).status).toBe(200)
  expect((await s.issueGrant('2001:db8:ffff:2::1')).status).toBe(200)
  expect((await s.registerClient('2001:db8:ffff:3::1')).status).toBe(200)
  expect((await s.hostSelf('2001:db8:ffff:4::1')).status).toBe(200)
  expect(s.deps.supabase.getUser).toHaveBeenCalledTimes(3)
}, 60_000)
