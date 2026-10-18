import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ROUTES, DEFAULT_CONTROL_URL, CONTROL_ERROR_STATUS } from '@shared/control-api'
import { controlUrl, createControlClient } from './client'
import {
  MACHINE,
  LOOKUP,
} from '../../../../libs/client-ui/src/features/machines/__fixtures__/control'

const me = { account: { login: 'octo' }, enabled: true, maxHosts: 20 }
const machines = { machines: [], serverTime: new Date().toISOString() }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function harness() {
  let token: string | null = randomBytes(32).toString('base64url')
  let generation = 0
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/me') ? json(me) : json(machines),
  )
  const accessToken = vi.fn(async () => token)
  const client = createControlClient({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken,
    generation: () => generation,
    fetch: fetchImpl,
  })
  return {
    client,
    fetchImpl,
    accessToken,
    signOut: () => {
      token = null
      generation++
    },
    signIn: () => {
      token = randomBytes(32).toString('base64url')
    },
  }
}

describe('controlUrl', () => {
  it('gates overrides on unpackaged builds and allows only https or loopback origins', () => {
    for (const raw of [
      'http://example.com',
      'file:///tmp/x',
      'https://x/path',
      'https://x/?q=1',
      'https://x/#f',
      'https://u:p@x',
      'junk',
      '',
    ]) {
      expect(() => controlUrl(false, { PHOSPHOR_CONTROL_URL: raw })).toThrow(
        'Invalid control server address.',
      )
      expect(controlUrl(true, { PHOSPHOR_CONTROL_URL: raw })).toBe(DEFAULT_CONTROL_URL)
    }
    for (const raw of [
      'https://example.com',
      'http://127.0.0.1:1234',
      'http://localhost:1234',
      'http://[::1]:1234',
    ]) {
      expect(controlUrl(false, { PHOSPHOR_CONTROL_URL: raw })).toBe(raw)
    }
    expect(controlUrl(false, {})).toBe(DEFAULT_CONTROL_URL)
  })
})

describe('createControlClient', () => {
  it('makes no request without a token', async () => {
    const h = harness()
    h.signOut()
    expect(await h.client.machines()).toMatchObject({ ok: false, error: { code: 'signed-out' } })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
  it('creates the account first, caches me until sign-out and gets a token per call', async () => {
    const h = harness()
    await Promise.all([h.client.machines(), h.client.machines()])
    expect(h.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.machines,
      CONTROL_ROUTES.machines,
    ])
    expect(h.accessToken).toHaveBeenCalledTimes(2)
    h.signOut()
    h.signIn()
    await h.client.machines()
    expect(h.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/me'))).toHaveLength(2)
    expect(h.fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
    })
  })
  it('does not pass a disabled account or a late account response after sign-out', async () => {
    const h = harness()
    h.fetchImpl.mockResolvedValueOnce(json({ ...me, enabled: false }))
    expect(await h.client.machines()).toMatchObject({ error: { code: 'forbidden' } })
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
    const late = harness()
    late.fetchImpl.mockImplementationOnce(async () => {
      late.signOut()
      return json(me)
    })
    expect(await late.client.machines()).toMatchObject({ error: { code: 'signed-out' } })
    expect(late.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('re-asks me when the token refreshes, so a lifted suspension takes effect', async () => {
    const h = harness()
    h.fetchImpl.mockResolvedValueOnce(json({ ...me, enabled: false }))
    expect(await h.client.machines()).toMatchObject({ error: { code: 'forbidden' } })
    // Same token, same generation: the cached answer stands.
    expect(await h.client.machines()).toMatchObject({ error: { code: 'forbidden' } })
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
    h.signIn() // a refresh rotates the token without a sign-out
    expect(await h.client.machines()).toMatchObject({ ok: true })
    expect(h.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.me,
      CONTROL_ROUTES.machines,
    ])
  })
  it('drops a token acquired across an account change before any request', async () => {
    const h = harness()
    h.accessToken.mockImplementationOnce(async () => {
      h.signOut()
      h.signIn()
      return randomBytes(32).toString('base64url')
    })
    expect(await h.client.machines()).toMatchObject({ error: { code: 'signed-out' } })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
  it('drops a machine response arriving after an account change', async () => {
    const h = harness()
    await h.client.machines()
    h.fetchImpl.mockImplementationOnce(async () => {
      h.signOut()
      return json(machines)
    })
    expect(await h.client.machines()).toMatchObject({ error: { code: 'signed-out' } })
  })
  it('maps 401 to signed-out without retry and drops the me cache', async () => {
    const h = harness()
    await h.client.machines()
    h.fetchImpl.mockResolvedValueOnce(json({}, 401))
    expect(await h.client.machines()).toMatchObject({ error: { code: 'signed-out' } })
    expect(h.fetchImpl).toHaveBeenCalledTimes(3)
    await h.client.machines()
    expect(h.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/me'))).toHaveLength(2)
  })
  it('keeps 401 and oversized response failures closed even if stream cancellation fails', async () => {
    for (const status of [401, 200]) {
      const h = harness()
      await h.client.machines()
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1))
          },
          cancel() {
            throw new Error('not displayed')
          },
        }),
        { status },
      )
      h.fetchImpl.mockResolvedValueOnce(response)
      expect(await h.client.machines()).toMatchObject({
        error: { code: status === 401 ? 'signed-out' : 'internal' },
      })
    }
  })
  it('maps a ten second timeout and token acquisition outages to offline', async () => {
    const h = harness()
    h.fetchImpl.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      throw new DOMException('Timeout', 'TimeoutError')
    })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(await h.client.machines()).toMatchObject({ error: { code: 'offline' } })
    expect(timeout).toHaveBeenCalledWith(10_000)
    timeout.mockRestore()
    h.accessToken.mockRejectedValueOnce(new Error(randomBytes(32).toString('hex')))
    expect(await h.client.machines()).toMatchObject({ error: { code: 'offline' } })
  })
  it('rejects malformed JSON, malformed shapes and unexpected successful status codes', async () => {
    for (const response of [new Response('{'), json({}), json(machines, 201)]) {
      const h = harness()
      await h.client.machines()
      h.fetchImpl.mockResolvedValueOnce(response)
      expect(await h.client.machines()).toMatchObject({ error: { code: 'internal' } })
    }
    for (const body of [{}, { account: { login: 'octo' }, enabled: 'yes', maxHosts: 20 }]) {
      const h = harness()
      h.fetchImpl.mockResolvedValueOnce(json(body))
      expect(await h.client.machines()).toMatchObject({ error: { code: 'internal' } })
      expect(h.fetchImpl).toHaveBeenCalledTimes(1)
    }
  })
  it('caps streamed bytes at 64 KiB, exactly at the limit and one byte past', async () => {
    const raw = JSON.stringify(machines)
    for (const bytes of [64 * 1024, 64 * 1024 + 1]) {
      const h = harness()
      await h.client.machines()
      const cancel = vi.fn()
      const response = new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(raw.padEnd(bytes, ' ')))
            if (bytes === 64 * 1024) c.close()
          },
          cancel,
        }),
      )
      h.fetchImpl.mockResolvedValueOnce(response)
      expect((await h.client.machines()).ok).toBe(bytes === 64 * 1024)
      expect(cancel).toHaveBeenCalledTimes(bytes === 64 * 1024 ? 0 : 1)
    }
  })
  it('normalizes code and label and never echoes server error messages', async () => {
    const h = harness()
    await h.client.approveEnrollment('bcdf ghjk', ' bee1 ')
    expect(JSON.parse(String(h.fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      userCode: 'BCDFGHJK',
      label: 'bee1',
    })
    const secret = randomBytes(32).toString('hex')
    h.fetchImpl.mockResolvedValueOnce(json({ error: { code: 'conflict', message: secret } }, 409))
    const result = await h.client.lookupEnrollment('BCDF-GHJK')
    expect(result).toMatchObject({ error: { code: 'conflict' } })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('parses successful lookup and approval responses without forwarding unknown fields', async () => {
    const h = harness()
    await h.client.machines()
    h.fetchImpl.mockResolvedValueOnce(json({ ...LOOKUP, unexpected: 'discarded' }))
    expect(await h.client.lookupEnrollment('bcdf ghjk')).toEqual({ ok: true, ...LOOKUP })
    h.fetchImpl.mockResolvedValueOnce(json({ machine: MACHINE }))
    expect(await h.client.approveEnrollment('BCDF-GHJK', 'bee1')).toEqual({
      ok: true,
      machine: MACHINE,
    })
  })
  it('maps all contract errors and refuses unknown or inherited error codes', async () => {
    const h = harness()
    await h.client.machines()
    for (const [code, status] of Object.entries(CONTROL_ERROR_STATUS)) {
      h.fetchImpl.mockResolvedValueOnce(json({ error: { code, message: '' } }, status))
      expect(await h.client.machines()).toMatchObject({
        error: { code: code === 'unauthenticated' ? 'signed-out' : code },
      })
      // A 401 drops /me. Re-prime it before the next peer error.
      if (status === 401) await h.client.machines()
    }
    for (const code of ['unknown', 'constructor', 'toString']) {
      h.fetchImpl.mockResolvedValueOnce(json({ error: { code, message: '' } }, 400))
      expect(await h.client.machines()).toMatchObject({ error: { code: 'internal' } })
    }
  })
  it('requires an empty 204 for removal and validates every other response', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const h = harness()
    await h.client.machines()
    h.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await h.client.removeMachine(id)).toEqual({ ok: true })
    const nonempty204 = new Response(null, { status: 204 })
    // Fetch normally strips a 204 body. The transport still enforces zero bytes itself.
    Object.defineProperty(nonempty204, 'body', {
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('null'))
          controller.close()
        },
      }),
    })
    for (const response of [
      nonempty204,
      json({}),
      new Response(null),
      json({ error: { code: 'not-found', message: '' } }, 404),
    ]) {
      h.fetchImpl.mockResolvedValueOnce(response)
      expect(await h.client.removeMachine(id)).toMatchObject({ ok: false })
    }
    h.fetchImpl.mockResolvedValueOnce(json({}))
    expect(await h.client.lookupEnrollment('BCDFGHJK')).toMatchObject({
      error: { code: 'internal' },
    })
    h.fetchImpl.mockResolvedValueOnce(json({ machine: {} }))
    expect(await h.client.approveEnrollment('BCDFGHJK', 'bee1')).toMatchObject({
      error: { code: 'internal' },
    })
  })
  it('rejects every bad renderer argument before token access or network traffic', async () => {
    const h = harness()
    for (const code of [null, 7, {}, 'ABCDFGHJ', 'B'.repeat(33)])
      expect(await h.client.lookupEnrollment(code)).toMatchObject({
        error: { code: 'bad-request' },
      })
    for (const label of [
      null,
      7,
      '',
      ' ',
      'b'.repeat(81),
      'a\n',
      'a\u202eb',
      'a\u2028b',
      'a\u2029b',
    ])
      expect(
        await h.client.approveEnrollment('BCDFGHJK', label === 'a\n' ? 'a\nb' : label),
      ).toMatchObject({ error: { code: 'bad-request' } })
    expect(await h.client.approveEnrollment('wrong', 'bee1')).toMatchObject({
      error: { code: 'bad-request' },
    })
    for (const id of [null, 7, '../x', 'not-a-uuid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])
      expect(await h.client.removeMachine(id)).toMatchObject({ error: { code: 'bad-request' } })
    expect(h.accessToken).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
})

it('renames with a validated UUID and label and parses the reply', async () => {
  const h = harness()
  for (const [id, label] of [
    ['../escape', 'label'],
    [MACHINE.id, ''],
    [MACHINE.id, 'a'.repeat(81)],
    [MACHINE.id, 'hidden\u202e'],
  ]) {
    expect(await h.client.renameMachine(id, label)).toMatchObject({
      error: { code: 'bad-request' },
    })
  }
  expect(h.fetchImpl).not.toHaveBeenCalled()
  h.fetchImpl
    .mockResolvedValueOnce(json(me))
    .mockResolvedValueOnce(json({ machine: { ...MACHINE, label: 'a'.repeat(80) } }))
  expect(await h.client.renameMachine(MACHINE.id, 'a'.repeat(80))).toMatchObject({
    ok: true,
    machine: { label: 'a'.repeat(80) },
  })
  expect(h.fetchImpl.mock.calls[1]?.[1]).toMatchObject({
    method: 'PATCH',
    body: JSON.stringify({ label: 'a'.repeat(80) }),
  })
  expect(String(h.fetchImpl.mock.calls[1]?.[0])).toBe(
    `${DEFAULT_CONTROL_URL}${CONTROL_ROUTES.machines}/${MACHINE.id}`,
  )
  h.fetchImpl.mockResolvedValueOnce(json({ machine: { id: MACHINE.id } }))
  expect(await h.client.renameMachine(MACHINE.id, 'new')).toMatchObject({
    error: { code: 'internal' },
  })
})

it('links lookup and approve calls, separates refreshes, and logs no token, code or peer text', async () => {
  const token = randomBytes(32).toString('hex')
  const peerSecret = randomBytes(32).toString('hex')
  const log = vi.fn()
  const headers: Headers[] = []
  let generation = 0
  let signedOut = false
  const client = createControlClient({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken: async () => (signedOut ? null : token),
    generation: () => generation,
    version: () => '1.2.3',
    now: () => Date.parse(LOOKUP.expiresAt) - 1000,
    log,
    fetch: async (url, init) => {
      headers.push(new Headers(init?.headers))
      const path = new URL(String(url)).pathname
      if (init?.method === 'DELETE')
        return new Response(null, { status: 204, headers: { 'x-request-id': '1'.repeat(32) } })
      const body =
        path === CONTROL_ROUTES.me
          ? me
          : path === CONTROL_ROUTES.enrollmentLookup
            ? LOOKUP
            : path === CONTROL_ROUTES.enrollmentApprove
              ? { machine: MACHINE }
              : { machines: [MACHINE], serverTime: new Date().toISOString() }
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json', 'x-request-id': '1'.repeat(32) },
      })
    },
  })
  await client.machines()
  await client.lookupEnrollment('BCDF-GHJK')
  await client.approveEnrollment('BCDF-GHJK', 'bee1')
  await client.machines()
  expect(await client.removeMachine(MACHINE.id)).toEqual({ ok: true })
  const calls = log.mock.calls.filter(([, message]) => message === 'call').map(([, , data]) => data)
  expect(calls.map((call) => call.route)).toEqual([
    CONTROL_ROUTES.me,
    CONTROL_ROUTES.machines,
    CONTROL_ROUTES.enrollmentLookup,
    CONTROL_ROUTES.enrollmentApprove,
    CONTROL_ROUTES.machines,
    CONTROL_ROUTES.machines + '/:id',
  ])
  expect(calls[0].trace).toBe(calls[1].trace)
  expect(calls[2].trace).toBe(calls[3].trace)
  expect(new Set([calls[1].trace, calls[2].trace, calls[4].trace]).size).toBe(3)
  for (let n = 0; n < headers.length; n++) {
    expect(headers[n]?.get('x-phosphor-client')).toBe('desktop/1.2.3')
    expect(headers[n]?.get('x-phosphor-trace')).toBe(calls[n].trace)
    expect(calls[n]).toMatchObject({
      status: n === 5 ? 204 : 200,
      requestId: '1'.repeat(32),
      code: null,
    })
  }
  expect(log.mock.calls.filter(([scope]) => scope === 'machines')).toHaveLength(1)
  generation++
  await client.machines()
  expect(log.mock.calls.filter(([scope]) => scope === 'machines')).toHaveLength(2)
  client.clearObservations()
  await client.machines()
  expect(log.mock.calls.filter(([scope]) => scope === 'machines')).toHaveLength(3)
  signedOut = true
  await client.machines()
  signedOut = false
  await client.machines()
  expect(log.mock.calls.filter(([scope]) => scope === 'machines')).toHaveLength(4)
  const failed = createControlClient({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken: async () => token,
    generation: () => 0,
    log,
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: 'unavailable', message: peerSecret } }), {
        status: 503,
        headers: { 'x-request-id': peerSecret },
      }),
  })
  await failed.machines()
  expect(log).toHaveBeenLastCalledWith(
    'control',
    'call',
    expect.objectContaining({ status: 503, requestId: null, code: 'unavailable' }),
  )
  const text = JSON.stringify(log.mock.calls)
  for (const secret of [token, 'BCDFGHJK', 'BCDF-GHJK', peerSecret])
    expect(text).not.toContain(secret)
})

it('logs a safe network class, not the transport exception name or message', async () => {
  const secret = randomBytes(32).toString('hex')
  const log = vi.fn()
  const client = createControlClient({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken: async () => secret,
    generation: () => 0,
    log,
    fetch: async () => {
      throw new TypeError(secret)
    },
  })
  expect(await client.machines()).toMatchObject({ ok: false, error: { code: 'offline' } })
  expect(log).toHaveBeenLastCalledWith(
    'control',
    'call',
    expect.objectContaining({ code: 'TypeError', status: 0, requestId: null }),
  )
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
})

it('bounds pending enrollment traces by expiry, clears failures and account changes, and consumes approval', async () => {
  let now = Date.parse(LOOKUP.expiresAt) - 1000
  let generation = 0
  let fail = false
  let token: string | null = randomBytes(32).toString('hex')
  let expiresAt = LOOKUP.expiresAt
  const log = vi.fn()
  const client = createControlClient({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken: async () => token,
    generation: () => generation,
    now: () => now,
    log,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname
      return path === CONTROL_ROUTES.me
        ? json(me)
        : path === CONTROL_ROUTES.enrollmentLookup
          ? fail
            ? json({ error: { code: 'not-found', message: 'not-found' } }, 404)
            : json({ ...LOOKUP, expiresAt })
          : json({ machine: MACHINE })
    },
  })
  const lastTrace = () => log.mock.calls.at(-1)?.[2].trace
  await client.lookupEnrollment('BCDFGHJK')
  const first = lastTrace()
  now += 999
  await client.approveEnrollment('BCDFGHJK', 'bee1')
  expect(lastTrace()).toBe(first)
  await client.approveEnrollment('BCDFGHJK', 'bee1')
  expect(lastTrace()).not.toBe(first)
  now -= 999
  await client.lookupEnrollment('BCDFGHJK')
  const second = lastTrace()
  now += 1000
  await client.approveEnrollment('BCDFGHJK', 'bee1')
  expect(lastTrace()).not.toBe(second)
  expiresAt = new Date(now + 60 * 60_000).toISOString()
  await client.lookupEnrollment('BCDFGHJK')
  const capped = lastTrace()
  now += 15 * 60_000
  await client.approveEnrollment('BCDFGHJK', 'bee1')
  expect(lastTrace()).not.toBe(capped)
  await client.lookupEnrollment('BCDFGHJK')
  const beforeFailure = lastTrace()
  fail = true
  await client.lookupEnrollment('BCDFGHJK')
  const failed = lastTrace()
  await client.approveEnrollment('BCDFGHJK', 'bee1')
  expect(lastTrace()).not.toBe(beforeFailure)
  expect(lastTrace()).not.toBe(failed)
  fail = false
  await client.lookupEnrollment('BCDFGHJK')
  const beforeChange = lastTrace()
  generation++
  await client.approveEnrollment('BCDFGHJK', 'bee1')
  expect(lastTrace()).not.toBe(beforeChange)
  await client.lookupEnrollment('BCDFGHJK')
  const beforeSignOut = lastTrace()
  token = null
  await client.machines()
  token = randomBytes(32).toString('hex')
  await client.approveEnrollment('BCDFGHJK', 'bee1')
  expect(lastTrace()).not.toBe(beforeSignOut)
})

it('keeps fingerprints authoritative when overlapping windows swap pending traces', async () => {
  const log = vi.fn()
  let resolveFirst: ((response: Response) => void) | undefined
  let lookups = 0
  const other = '1234-5678-90ab-cdef'
  const client = createControlClient({
    baseUrl: () => DEFAULT_CONTROL_URL,
    accessToken: async () => randomBytes(32).toString('hex'),
    generation: () => 0,
    log,
    now: () => Date.parse(LOOKUP.expiresAt) - 1000,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname
      if (path === CONTROL_ROUTES.me) return json(me)
      if (path === CONTROL_ROUTES.enrollmentApprove)
        return json({ machine: { ...MACHINE, keyFingerprint: other } })
      lookups++
      if (lookups === 1)
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve
        })
      return json({ ...LOOKUP, keyFingerprint: other })
    },
  })
  const first = client.lookupEnrollment('BCDFGHJK')
  await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'))
  await client.lookupEnrollment('BCDFGHJL')
  resolveFirst?.(json(LOOKUP))
  await first
  await client.approveEnrollment('BCDFGHJL', 'bee1')
  const events = log.mock.calls
    .filter(([, name]) => name.startsWith('enrollment.'))
    .map(([, name, data]) => ({ name, ...data }))
  expect(events.map((entry) => entry.keyFingerprint)).toEqual([other, LOOKUP.keyFingerprint, other])
  expect(events[2].trace).toBe(events[1].trace)
  expect(events[2].trace).not.toBe(events[0].trace)
  for (const code of ['BCDFGHJK', 'BCDFGHJL'])
    expect(JSON.stringify(log.mock.calls)).not.toContain(code)
})

it('validates client and grant requests and replies through the main control transport', async () => {
  const h = harness(),
    hostId = randomUUID(),
    clientId = randomUUID()
  const grant = `phosphor-grant.v1.${randomBytes(32).toString('base64url')}.${randomBytes(64).toString('base64url')}`
  const reply = {
    grant,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    host: {
      id: hostId,
      endpoint: 'https://test.ts.net',
      publicKey: randomBytes(32).toString('base64url'),
    },
  }
  h.fetchImpl.mockImplementation(async (url) =>
    String(url).endsWith('/me')
      ? json(me)
      : String(url).endsWith('/clients')
        ? json({ client: { id: clientId, label: 'Viewer' } })
        : json(reply),
  )
  expect(await h.client.registerClient('Viewer')).toMatchObject({
    ok: true,
    client: { id: clientId },
  })
  expect(await h.client.grant(hostId, clientId)).toMatchObject({ ok: true, host: { id: hostId } })
  expect(h.fetchImpl.mock.calls.at(-1)?.[1]?.body).toBe(JSON.stringify({ hostId, clientId }))
  const count = h.fetchImpl.mock.calls.length
  expect(await h.client.grant('bad', clientId)).toMatchObject({ error: { code: 'bad-request' } })
  expect(await h.client.registerClient('\n')).toMatchObject({ error: { code: 'bad-request' } })
  expect(h.fetchImpl).toHaveBeenCalledTimes(count)
  h.fetchImpl.mockResolvedValueOnce(json({ ...reply, host: { ...reply.host, publicKey: 'bad' } }))
  expect(await h.client.grant(hostId, clientId)).toMatchObject({ error: { code: 'internal' } })
})
