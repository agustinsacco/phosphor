import { expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CONTROL_ROUTES as R,
  HOST_HEADERS,
  parseEnrollmentCreateResponse,
  parseEnrollmentPollResponse,
  parseEnrollmentLookupResponse,
  parseEnrollmentApproveResponse,
} from '@phosphor/shared/control-api'
import { token, userId } from '../test-support'
import { date, machine, setup, routeContracts } from './__fixtures__/fixtures'

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
] as const
routeContracts(routes)

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
