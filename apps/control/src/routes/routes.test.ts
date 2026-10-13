import { describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CONTROL_ROUTES as R,
  HOST_HEADERS,
  formatKeyFingerprint,
  parseEnrollmentCreateResponse,
  parseEnrollmentPollResponse,
  parseEnrollmentLookupResponse,
  parseEnrollmentApproveResponse,
  parseMachinesResponse,
  parseHostSelfResponse,
  parseHeartbeatResponse,
  parseControlError,
} from '@phosphor/shared/control-api'
import { createApp } from '../app'
import { dependencies, signingKey, token, userId } from '../test-support'
import { RateLimiter } from '../limits'
import { parseConfig } from '../config'

const date = '2026-10-12T12:00:00.000Z'
const machine = {
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
const heartbeat = {
  seq: 1,
  state: 'running',
  hostVersion: '1.0.0',
  uptimeSec: 1,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  lanes: { running: 0, waiting: 0 },
  endpoint: null,
}
function setup() {
  const deps = dependencies()
  const key = signingKey()
  let now = deps.clock()
  deps.clock = () => now
  deps.limits = new RateLimiter(deps.clock)
  const results: Record<string, unknown> = {
    control_account: { enabled: true, maxHosts: 20 },
    control_host_key: { outcome: 'active', publicKey: key.publicKey },
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
const routes = [
  {
    path: R.enrollments,
    method: 'POST',
    mode: 'key',
    rpc: 'control_enrollment_create',
    value: { publicKey: '', hostname: 'bee', platform: 'linux', arch: 'x64', hostVersion: '1.0.0' },
    answer: { outcome: 'created', enrollmentId: userId, expiresAt: date },
    parser: parseEnrollmentCreateResponse,
    outcomes: { 'key-in-use': 409, busy: 503 },
  },
  {
    path: R.enrollmentPoll,
    method: 'POST',
    mode: 'key',
    rpc: 'control_enrollment_poll',
    value: { enrollmentId: userId },
    answer: { outcome: 'pending' },
    parser: parseEnrollmentPollResponse,
    outcomes: { 'not-found': 404 },
  },
  {
    path: R.enrollmentLookup,
    method: 'POST',
    mode: 'user',
    rpc: 'control_enrollment_lookup',
    value: { userCode: 'bcdf-ghjk' },
    answer: {
      outcome: 'found',
      hostname: 'bee',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '1.0.0',
      keyFingerprint: machine.keyFingerprint,
      expiresAt: date,
    },
    parser: parseEnrollmentLookupResponse,
    outcomes: { 'not-found': 404 },
  },
  {
    path: R.enrollmentApprove,
    method: 'POST',
    mode: 'user',
    rpc: 'control_enrollment_approve',
    value: { userCode: 'bcdf-ghjk', label: ' bee ' },
    answer: { outcome: 'approved', machine },
    parser: parseEnrollmentApproveResponse,
    outcomes: { 'not-found': 404, 'account-disabled': 403, 'host-limit': 409, 'key-in-use': 409 },
  },
  {
    path: R.machines,
    method: 'GET',
    mode: 'user',
    rpc: 'control_machines',
    value: undefined,
    answer: { machines: [machine], serverTime: date },
    parser: parseMachinesResponse,
    outcomes: {},
  },
  {
    path: R.machines + '/' + userId,
    method: 'PATCH',
    mode: 'user',
    rpc: 'control_machine_rename',
    value: { label: ' bee ' },
    answer: { outcome: 'renamed', machine },
    parser: parseEnrollmentApproveResponse,
    outcomes: { 'not-found': 404 },
  },
  {
    path: R.machines + '/' + userId,
    method: 'DELETE',
    mode: 'user',
    rpc: 'control_machine_revoke',
    value: undefined,
    answer: { outcome: 'revoked' },
    parser: null,
    outcomes: { 'not-found': 404 },
  },
  {
    path: R.hostSelf,
    method: 'GET',
    mode: 'host',
    rpc: 'control_host_self',
    value: undefined,
    answer: {
      outcome: 'active',
      hostId: userId,
      label: 'bee',
      owner: { login: 'tester' },
      enrolledAt: date,
      lastSeenAt: null,
    },
    parser: parseHostSelfResponse,
    outcomes: { gone: 410 },
  },
  {
    path: R.hostHeartbeat,
    method: 'POST',
    mode: 'host',
    rpc: 'control_host_heartbeat',
    value: heartbeat,
    answer: { outcome: 'accepted' },
    parser: parseHeartbeatResponse,
    outcomes: { stale: 409, 'too-soon': 429, gone: 410 },
  },
  {
    path: R.hostRevoke,
    method: 'POST',
    mode: 'host',
    rpc: 'control_host_revoke_self',
    value: {},
    answer: { outcome: 'revoked' },
    parser: null,
    outcomes: { gone: 410 },
  },
] as const
for (const route of routes)
  describe(route.path + ' ' + route.method, () => {
    const input = (s: ReturnType<typeof setup>) =>
      route.path === R.enrollments ? { ...route.value, publicKey: s.key.publicKey } : route.value
    it('returns exactly the parsed contract and sets the authenticated actor', async () => {
      const s = setup()
      s.results[route.rpc] = { ...route.answer, extra: randomBytes(32).toString('hex') }
      const res = await s.call(route.path, route.method, input(s), route.mode)
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
        const res = await s.call(route.path, route.method, input(s), route.mode)
        expect(res.status).toBe(status)
        expect(parseControlError(await res.json())).not.toBeNull()
      })
    it('fails closed on malformed RPC output', async () => {
      const s = setup()
      s.results[route.rpc] = { outcome: 'unexpected' }
      expect((await s.call(route.path, route.method, input(s), route.mode)).status).toBe(503)
      s.advance(2000)
      s.results[route.rpc] = {
        outcome: route.answer && 'outcome' in route.answer ? route.answer.outcome : undefined,
      }
      if (
        route.parser &&
        route.rpc !== 'control_host_heartbeat' &&
        route.rpc !== 'control_enrollment_poll'
      )
        expect((await s.call(route.path, route.method, input(s), route.mode)).status).toBe(503)
    })
    it('refuses unauthenticated, unconfigured, incorrect methods and framed bodies', async () => {
      const s = setup()
      s.results[route.rpc] = route.answer
      expect(
        (
          await s.app.request(route.path, {
            method: route.method,
            headers: { 'content-type': 'application/json' },
            ...(input(s) === undefined ? {} : { body: JSON.stringify(input(s)) }),
          })
        ).status,
      ).toBe(401)
      s.deps.config = parseConfig({})
      expect((await s.call(route.path, route.method, input(s), route.mode)).status).toBe(503)
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
      if (input(s) !== undefined) {
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
    if (route.mode === 'user')
      it('refuses disabled accounts on every request', async () => {
        const s = setup()
        s.results.control_account = { enabled: false, maxHosts: 20 }
        expect((await s.call(route.path, route.method, input(s))).status).toBe(403)
        expect(s.deps.supabase.rpc).not.toHaveBeenCalledWith(route.rpc, expect.anything())
      })
  })
it('enforces create limit before bad signature and nonce consumption', async () => {
  const s = setup()
  const nonce = vi.spyOn(s.deps.nonces.key, 'accept')
  s.results.control_enrollment_create = routes[0].answer
  for (let i = 0; i < 10; i++)
    expect(
      (
        await s.call(
          R.enrollments,
          'POST',
          { ...routes[0].value, publicKey: s.key.publicKey },
          'key',
        )
      ).status,
    ).toBe(200)
  expect(
    (await s.call(R.enrollments, 'POST', { ...routes[0].value, publicKey: s.key.publicKey }, 'key'))
      .status,
  ).toBe(429)
  const req = s.key.request(
    'POST',
    R.enrollments,
    { ...routes[0].value, publicKey: s.key.publicKey },
    s.deps.clock(),
  )
  req.headers.set(HOST_HEADERS.signature, randomBytes(64).toString('base64url'))
  expect((await s.app.request(req)).status).toBe(429)
  expect(nonce).toHaveBeenCalledTimes(10)
  s.advance(3_600_000)
  expect(
    (await s.call(R.enrollments, 'POST', { ...routes[0].value, publicKey: s.key.publicKey }, 'key'))
      .status,
  ).toBe(200)
})
it('limits polls by parsed enrollment id before verification', async () => {
  const s = setup()
  s.results.control_enrollment_poll = { outcome: 'pending' }
  expect((await s.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')).status).toBe(200)
  const nonce = vi.spyOn(s.deps.nonces.key, 'accept')
  expect((await s.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')).status).toBe(429)
  expect(nonce).not.toHaveBeenCalled()
  expect((await s.call(R.enrollmentPoll, 'POST', { enrollmentId: 'invalid' }, 'key')).status).toBe(
    400,
  )
  expect(
    (
      await s.call(
        R.enrollmentPoll,
        'POST',
        { enrollmentId: '11111111-1111-4111-8111-111111111111' },
        'key',
      )
    ).status,
  ).toBe(200)
  s.advance(1999)
  expect((await s.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')).status).toBe(429)
  s.advance(1)
  expect((await s.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')).status).toBe(200)
})
it('limits polls per address before parsing, the per-enrollment key and verification', async () => {
  const s = setup()
  s.results.control_enrollment_poll = { outcome: 'pending' }
  const fresh = () => ({ enrollmentId: randomUUID() })
  for (let i = 0; i < 60; i++)
    expect((await s.call(R.enrollmentPoll, 'POST', fresh(), 'key')).status).toBe(200)
  const nonce = vi.spyOn(s.deps.nonces.key, 'accept')
  const before = s.deps.limits.size
  expect((await s.call(R.enrollmentPoll, 'POST', fresh(), 'key')).status).toBe(429)
  const req = s.key.request('POST', R.enrollmentPoll, fresh(), s.deps.clock())
  req.headers.set(HOST_HEADERS.signature, randomBytes(64).toString('base64url'))
  expect((await s.app.request(req)).status).toBe(429)
  expect(nonce).not.toHaveBeenCalled()
  expect(s.deps.limits.size).toBe(before)
  s.advance(60_000)
  expect((await s.call(R.enrollmentPoll, 'POST', fresh(), 'key')).status).toBe(200)
})
it('shares failed lookup/approve budget without charging successful requests', async () => {
  const s = setup()
  s.results.control_enrollment_lookup = routes[2].answer
  for (let i = 0; i < 11; i++)
    expect((await s.call(R.enrollmentLookup, 'POST', routes[2].value)).status).toBe(200)
  s.results.control_enrollment_lookup = s.results.control_enrollment_approve = {
    outcome: 'not-found',
  }
  for (let i = 0; i < 10; i++)
    expect(
      (await s.call(i % 2 ? R.enrollmentApprove : R.enrollmentLookup, 'POST', routes[3].value))
        .status,
    ).toBe(404)
  for (const path of [R.enrollmentLookup, R.enrollmentApprove])
    expect((await s.call(path, 'POST', routes[3].value)).status).toBe(429)
  // A spent budget refuses even a correct guess, before the database sees it.
  s.results.control_enrollment_lookup = routes[2].answer
  s.results.control_enrollment_approve = routes[3].answer
  const rpc = vi.mocked(s.deps.supabase.rpc)
  rpc.mockClear()
  expect((await s.call(R.enrollmentLookup, 'POST', routes[2].value)).status).toBe(429)
  expect((await s.call(R.enrollmentApprove, 'POST', routes[3].value)).status).toBe(429)
  expect(rpc).not.toHaveBeenCalledWith('control_enrollment_lookup', expect.anything())
  expect(rpc).not.toHaveBeenCalledWith('control_enrollment_approve', expect.anything())
  s.results.control_enrollment_lookup = s.results.control_enrollment_approve = {
    outcome: 'not-found',
  }
  s.advance(15 * 60_000 - 1)
  expect((await s.call(R.enrollmentLookup, 'POST', routes[2].value)).status).toBe(429)
  s.advance(1)
  expect((await s.call(R.enrollmentLookup, 'POST', routes[2].value)).status).toBe(404)
})
it('counts concurrent in-flight guesses against the failure budget (review r1)', async () => {
  const s = setup()
  const rpc = vi.mocked(s.deps.supabase.rpc)
  const gates: Array<{ name: string; resolve: (value: unknown) => void }> = []
  rpc.mockImplementation(async (name) =>
    name === 'control_enrollment_lookup' || name === 'control_enrollment_approve'
      ? new Promise((resolve) => gates.push({ name, resolve }))
      : s.results[name],
  )
  const guesses = () =>
    rpc.mock.calls.filter(
      ([name]) => name === 'control_enrollment_lookup' || name === 'control_enrollment_approve',
    ).length
  // Three failures already recorded, so seven more guesses may be in flight.
  s.results.control_enrollment_lookup = { outcome: 'not-found' }
  for (let i = 0; i < 3; i++) {
    const pending = s.call(R.enrollmentLookup, 'POST', routes[3].value)
    await vi.waitFor(() => expect(gates.length).toBe(1))
    gates.shift()?.resolve({ outcome: 'not-found' })
    expect((await pending).status).toBe(404)
  }
  let settled = 0
  const flight = Array.from({ length: 7 }, (_, i) =>
    Promise.resolve(
      s.call(i % 2 ? R.enrollmentApprove : R.enrollmentLookup, 'POST', routes[3].value),
    ).then((response) => {
      settled++
      return response
    }),
  )
  await vi.waitFor(() => expect(gates.length).toBe(7))
  for (const path of [R.enrollmentLookup, R.enrollmentApprove])
    expect((await s.call(path, 'POST', routes[3].value)).status).toBe(429)
  expect(guesses()).toBe(10)
  // One in-flight guess succeeding frees its place without spending the budget.
  const first = gates.shift()
  first?.resolve(first.name === 'control_enrollment_lookup' ? routes[2].answer : routes[3].answer)
  await vi.waitFor(() => expect(settled).toBe(1))
  const late = s.call(R.enrollmentApprove, 'POST', routes[3].value)
  await vi.waitFor(() => expect(gates.length).toBe(7))
  // Exactly one place was freed: the others' reservations still hold.
  expect((await s.call(R.enrollmentLookup, 'POST', routes[3].value)).status).toBe(429)
  for (const gate of gates.splice(0)) gate.resolve({ outcome: 'not-found' })
  const statuses = (await Promise.all([...flight, late])).map((r) => r.status).sort()
  expect(statuses).toEqual([200, 404, 404, 404, 404, 404, 404, 404])
  // Ten failures: even a correct guess is now refused before the database.
  const before = guesses()
  expect((await s.call(R.enrollmentApprove, 'POST', routes[3].value)).status).toBe(429)
  expect(guesses()).toBe(before)
})
it('retries collisions exactly three times, redraws unusable bytes and stores only code hash', async () => {
  const s = setup()
  s.results.control_enrollment_create = { outcome: 'code-collision' }
  const create = () =>
    s.call(R.enrollments, 'POST', { ...routes[0].value, publicKey: s.key.publicKey }, 'key')
  expect((await create()).status).toBe(503)
  expect(
    vi
      .mocked(s.deps.supabase.rpc)
      .mock.calls.filter(([name]) => name === 'control_enrollment_create'),
  ).toHaveLength(3)
  s.results.control_enrollment_create = routes[0].answer
  const random = vi.fn((size: number): Uint8Array => randomBytes(size))
  random.mockReturnValueOnce(new Uint8Array(32).fill(255))
  s.deps.random = random
  const res = await create()
  const value = parseEnrollmentCreateResponse(await res.json())
  expect(value.ok).toBe(true)
  if (!value.ok) throw new Error('invalid response')
  expect(random).toHaveBeenCalledTimes(2)
  expect(s.deps.supabase.rpc).toHaveBeenLastCalledWith(
    'control_enrollment_create',
    expect.objectContaining({
      p_code_hash: createHash('sha256').update(value.value.userCode).digest('hex'),
    }),
  )
  const logs = JSON.stringify(vi.mocked(s.deps.log).mock.calls)
  expect(logs).not.toContain(value.value.userCode)
  expect(logs).not.toContain(s.key.publicKey)
  const request = s.key.request(
    'POST',
    R.enrollments,
    { ...routes[0].value, publicKey: s.key.publicKey },
    s.deps.clock(),
  )
  await s.app.request(request)
  const allLogs = JSON.stringify(vi.mocked(s.deps.log).mock.calls)
  for (const name of [HOST_HEADERS.signature, HOST_HEADERS.key])
    expect(allLogs).not.toContain(request.headers.get(name))
  expect(allLogs).not.toContain(token(s.deps.clock() / 1000 + 100))
  const exhausted = vi.fn((size: number) => new Uint8Array(size).fill(255))
  s.deps.random = exhausted
  expect((await create()).status).toBe(503)
  expect(exhausted).toHaveBeenCalledTimes(3)
})
it('checks key equality, normalizes label and codes and rejects invalid route ids/revoke bodies', async () => {
  const s = setup()
  expect(
    (
      await s.call(
        R.enrollments,
        'POST',
        { ...routes[0].value, publicKey: signingKey().publicKey },
        'key',
      )
    ).status,
  ).toBe(400)
  s.results.control_enrollment_approve = routes[3].answer
  expect((await s.call(R.enrollmentApprove, 'POST', routes[3].value)).status).toBe(200)
  expect(s.deps.supabase.rpc).toHaveBeenLastCalledWith('control_enrollment_approve', {
    p_user_id: userId,
    p_code_hash: createHash('sha256').update('BCDFGHJK').digest('hex'),
    p_label: 'bee',
  })
  for (const method of ['PATCH', 'DELETE'])
    expect(
      (await s.call(R.machines + '/bad', method, method === 'PATCH' ? { label: 'x' } : undefined))
        .status,
    ).toBe(400)
  for (const value of [[], { extra: true }, ''])
    expect((await s.call(R.hostRevoke, 'POST', value, 'host')).status).toBe(400)
  s.results.control_host_key = { outcome: 'gone' }
  expect((await s.call(R.hostSelf, 'GET', undefined, 'host')).status).toBe(410)
  s.results.control_host_key = { outcome: 'active', publicKey: 'bad' }
  expect((await s.call(R.hostSelf, 'GET', undefined, 'host')).status).toBe(503)
})
it('rejects a malformed approved poll response', async () => {
  const s = setup()
  s.results.control_enrollment_poll = { outcome: 'approved', hostId: userId }
  expect((await s.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')).status).toBe(503)
})
it('maps approved and expired polls through the contract', async () => {
  const s = setup()
  for (const answer of [
    { outcome: 'approved', hostId: userId, label: 'bee', owner: { login: 'tester' } },
    { outcome: 'expired' },
  ]) {
    s.results.control_enrollment_poll = answer
    const res = await s.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')
    expect(res.status).toBe(200)
    expect(parseEnrollmentPollResponse(await res.json()).ok).toBe(true)
    s.advance(2000)
  }
})

it('writes the ordered enrollment story and accepted host transitions, without secrets', async () => {
  const h = setup()
  const secrets: string[] = [h.key.publicKey, randomBytes(32).toString('hex')]
  const trace = randomBytes(8).toString('hex')
  const call = async (
    path: string,
    value?: unknown,
    mode: 'user' | 'key' | 'host' = 'user',
    method = 'POST',
  ) => {
    const request =
      mode === 'user'
        ? new Request('http://localhost' + path, {
            method,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token(h.deps.clock() / 1000 + 100)}`,
            },
            ...(value ? { body: JSON.stringify(value) } : {}),
          })
        : h.key.request(method, path, value, h.deps.clock(), mode === 'host' ? userId : undefined)
    request.headers.set('x-phosphor-client', mode === 'user' ? 'desktop/1.0.0' : 'host/1.0.0')
    request.headers.set('x-phosphor-trace', trace)
    request.headers.set('x-phosphor-edge', secrets[1] ?? '')
    for (const name of ['authorization', HOST_HEADERS.signature, HOST_HEADERS.nonce]) {
      const secret = request.headers.get(name)
      if (secret) secrets.push(secret)
    }
    return h.app.request(request)
  }
  h.results.control_enrollment_create = {
    outcome: 'created',
    enrollmentId: userId,
    expiresAt: date,
  }
  const created = await (
    await call(
      R.enrollments,
      {
        publicKey: h.key.publicKey,
        hostname: 'bee',
        platform: 'linux',
        arch: 'x64',
        hostVersion: '1.0.0',
      },
      'key',
    )
  ).json()
  const parsed = parseEnrollmentCreateResponse(created)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error('invalid fixture')
  const fingerprint = parsed.value.keyFingerprint
  secrets.push(parsed.value.userCode)
  h.results.control_enrollment_poll = { outcome: 'pending' }
  expect((await call(R.enrollmentPoll, { enrollmentId: userId }, 'key')).status).toBe(200)
  h.results.control_enrollment_lookup = {
    outcome: 'found',
    ...machine,
    keyFingerprint: fingerprint,
    expiresAt: date,
  }
  expect((await call(R.enrollmentLookup, { userCode: parsed.value.userCode })).status).toBe(200)
  h.results.control_enrollment_approve = {
    outcome: 'approved',
    machine: { ...machine, keyFingerprint: fingerprint },
  }
  expect(
    (await call(R.enrollmentApprove, { userCode: parsed.value.userCode, label: 'bee' })).status,
  ).toBe(200)
  h.advance(5000)
  h.results.control_enrollment_poll = {
    outcome: 'approved',
    hostId: userId,
    label: 'bee',
    owner: { login: 'tester' },
  }
  expect((await call(R.enrollmentPoll, { enrollmentId: userId }, 'key')).status).toBe(200)
  h.results.control_host_heartbeat = { outcome: 'accepted' }
  expect((await call(R.hostHeartbeat, heartbeat, 'host')).status).toBe(200)
  h.advance(10_000)
  expect((await call(R.hostHeartbeat, heartbeat, 'host')).status).toBe(200)
  h.advance(10_000)
  expect((await call(R.hostHeartbeat, { ...heartbeat, state: 'stopping' }, 'host')).status).toBe(
    200,
  )
  h.results.control_machine_revoke = { outcome: 'revoked' }
  expect((await call(R.machines + '/' + userId, undefined, 'user', 'DELETE')).status).toBe(204)
  h.results.control_host_key = { outcome: 'gone' }
  expect((await call(R.hostHeartbeat, heartbeat, 'host')).status).toBe(410)
  const entries = vi.mocked(h.deps.log).mock.calls.map(([entry]) => entry)
  const events = entries.filter((entry) => 'event' in entry)
  expect(events.map((entry) => ('event' in entry ? entry.event : ''))).toEqual([
    'enrollment.created',
    'enrollment.poll',
    'enrollment.lookup',
    'enrollment.approved',
    'enrollment.poll',
    'host.connected',
    'host.state',
    'host.removed',
    'host.refused',
  ])
  expect(events[0]).toMatchObject({ enrollmentId: userId, keyFingerprint: fingerprint })
  expect(events[2]).toMatchObject({ userId, keyFingerprint: fingerprint, result: 'found' })
  expect(events[3]).toMatchObject({ userId, hostId: userId, keyFingerprint: fingerprint })
  for (const entry of entries) {
    expect(entry.ts).toMatch(/^\d{4}-.*\.\d{3}Z$/)
    expect(entry.trace).toBe(trace)
    if ('route' in entry) {
      expect(entry.client).toMatch(/^(host|desktop)\/1.0.0$/)
      expect(entry.error).toBe(entry.status === 410 ? 'gone' : null)
      if (entry.route === R.hostHeartbeat && entry.status === 200)
        expect(entry.actor).toBe('host:' + userId)
    }
  }
  const text = JSON.stringify(entries)
  for (const secret of secrets) expect(text).not.toContain(secret)
  expect(text).not.toContain('p_code_hash')
})

it('does not observe refused beats, logs failed lookup and refused polls, and suppresses probe events', async () => {
  const h = setup()
  h.results.control_host_heartbeat = { outcome: 'stale' }
  expect((await h.call(R.hostHeartbeat, 'POST', heartbeat, 'host')).status).toBe(409)
  expect(vi.mocked(h.deps.log).mock.calls.filter(([entry]) => 'event' in entry)).toHaveLength(0)
  h.results.control_host_heartbeat = { outcome: 'accepted' }
  expect((await h.call(R.hostHeartbeat, 'POST', heartbeat, 'host')).status).toBe(200)
  expect(
    vi
      .mocked(h.deps.log)
      .mock.calls.filter(([entry]) => 'event' in entry)
      .map(([entry]) => ('event' in entry ? entry.event : '')),
  ).toEqual(['host.connected'])
  h.results.control_enrollment_lookup = { outcome: 'not-found' }
  expect((await h.call(R.enrollmentLookup, 'POST', { userCode: 'BCDFGHJK' })).status).toBe(404)
  expect(h.deps.log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'enrollment.lookup',
      keyFingerprint: null,
      result: 'not-found',
      userId,
    }),
  )
  h.results.control_enrollment_poll = { outcome: 'not-found' }
  expect((await h.call(R.enrollmentPoll, 'POST', { enrollmentId: userId }, 'key')).status).toBe(404)
  expect(h.deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'enrollment.poll', enrollmentId: userId, result: 'refused' }),
  )
  const count = vi.mocked(h.deps.log).mock.calls.length
  h.results.control_enrollment_create = {
    outcome: 'created',
    enrollmentId: userId,
    expiresAt: date,
  }
  const request = h.key.request(
    'POST',
    R.enrollments,
    {
      publicKey: h.key.publicKey,
      hostname: 'bee',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '1.0.0',
    },
    h.deps.clock(),
  )
  request.headers.set('user-agent', 'kube-probe/1')
  expect((await h.app.request(request)).status).toBe(200)
  // A probe user agent hides nothing: the access line and the event both log.
  const added = vi
    .mocked(h.deps.log)
    .mock.calls.slice(count)
    .map(([entry]) => entry)
  expect(added).toHaveLength(2)
  expect(added).toContainEqual(expect.objectContaining({ event: 'enrollment.created' }))
})
