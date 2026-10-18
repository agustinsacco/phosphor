import { expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  CONTROL_ROUTES as R,
  HOST_HEADERS,
  parseEnrollmentCreateResponse,
} from '@phosphor/shared/control-api'
import { token, userId } from '../test-support'
import { date, machine, heartbeat, setup } from './__fixtures__/fixtures'

function tracedCall(h: ReturnType<typeof setup>, trace: string, secrets: string[]) {
  return async (
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
}

async function approveEnrollment(
  h: ReturnType<typeof setup>,
  call: ReturnType<typeof tracedCall>,
  secrets: string[],
) {
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
  return fingerprint
}

it('writes the ordered enrollment story and accepted host transitions, without secrets', async () => {
  const h = setup()
  const secrets: string[] = [h.key.publicKey, randomBytes(32).toString('hex')]
  const trace = randomBytes(8).toString('hex')
  const call = tracedCall(h, trace, secrets)
  const fingerprint = await approveEnrollment(h, call, secrets)
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
it('does not observe refused beats, logs failed lookup and failed polls by code, and suppresses probe events', async () => {
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
    expect.objectContaining({
      event: 'enrollment.poll',
      enrollmentId: userId,
      result: 'not-found',
    }),
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
