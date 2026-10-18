import { createHash, createPublicKey, verify } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ERROR_STATUS,
  CONTROL_ROUTES,
  HOST_HEADERS,
  hostSigningString,
  type ControlErrorCode,
} from '@phosphor/shared/control-api'
import { ControlFailure, createControlClient } from './client'
import { freshKey, publicIdentity } from './signer'

const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const key = freshKey()
const { publicKey, keyFingerprint } = publicIdentity(key)
const origin = 'https://example.com'
const trace = '0123456789abcdef'
const self = {
  hostId,
  label: 'bee1',
  owner: { login: 'me' },
  enrolledAt: '2026-10-10T00:00:00.000Z',
  lastSeenAt: null,
}
const enrollment = {
  publicKey,
  hostname: 'bee1',
  platform: 'linux',
  arch: 'x64',
  hostVersion: '1.0.0',
} as const
const heartbeat = {
  seq: 7,
  state: 'running',
  hostVersion: '1.0.0',
  uptimeSec: 5,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  lanes: { running: 1, waiting: 0 },
  endpoint: null,
} as const
const clientWith = (response: Response) =>
  createControlClient(origin, { fetch: async () => response })
const body204 = (body: string) => {
  const response = new Response(body)
  Object.defineProperty(response, 'status', { value: 204 })
  return response
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('control client characterization', () => {
  it('signs the exact validated method, route and bytes for every endpoint without redirects', async () => {
    const seen: Array<[string, string, string | undefined]> = []
    const client = createControlClient(origin, {
      trace,
      now: () => 1792000000000,
      random: () => Buffer.alloc(16, 7),
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname
        const body = typeof init?.body === 'string' ? init.body : undefined
        seen.push([init?.method ?? '', path, body])
        const headers = new Headers(init?.headers)
        const identity = headers.get(HOST_HEADERS.key) ?? headers.get(HOST_HEADERS.host) ?? ''
        expect(headers.get('x-phosphor-trace')).toBe(trace)
        expect(headers.get('x-phosphor-client')).toBe('host/0.0.0-dev.source')
        expect(headers.get('content-type')).toBe('application/json')
        expect(init?.redirect).toBe('error')
        const signed = hostSigningString({
          method: init?.method ?? '',
          path,
          identity,
          timestamp: headers.get(HOST_HEADERS.timestamp) ?? '',
          nonce: headers.get(HOST_HEADERS.nonce) ?? '',
          bodySha256: createHash('sha256')
            .update(body ?? '')
            .digest('hex'),
        })
        expect(
          verify(
            null,
            Buffer.from(signed),
            createPublicKey(key),
            Buffer.from(headers.get(HOST_HEADERS.signature) ?? '', 'base64url'),
          ),
        ).toBe(true)
        if (path === CONTROL_ROUTES.hostSelf) return Response.json(self)
        if (path === CONTROL_ROUTES.hostRevoke) return new Response(null, { status: 204 })
        if (path === CONTROL_ROUTES.hostHeartbeat)
          return Response.json({ accepted: true, nextInSec: 30 })
        if (path === CONTROL_ROUTES.enrollmentPoll) return Response.json({ status: 'pending' })
        return Response.json({
          enrollmentId: hostId,
          userCode: 'BCDFGHJK',
          keyFingerprint,
          expiresAt: '2026-10-10T00:10:00.000Z',
          pollIntervalSec: 5,
        })
      },
    })
    await client.enroll(enrollment, key)
    await client.poll(hostId, publicKey, key)
    await client.self(hostId, key)
    await client.heartbeat(hostId, key, heartbeat)
    await client.revoke(hostId, key)
    expect(seen).toEqual([
      ['POST', CONTROL_ROUTES.enrollments, JSON.stringify(enrollment)],
      ['POST', CONTROL_ROUTES.enrollmentPoll, JSON.stringify({ enrollmentId: hostId })],
      ['GET', CONTROL_ROUTES.hostSelf, undefined],
      ['POST', CONTROL_ROUTES.hostHeartbeat, JSON.stringify(heartbeat)],
      ['POST', CONTROL_ROUTES.hostRevoke, '{}'],
    ])
  })

  it('rejects invalid origins and endpoint inputs before fetching, preserving sync versus async errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const url of ['http://public.example', `${origin}/path`, `${origin}?secret=x`])
      expect(() => createControlClient(url, { fetch: fetcher })).toThrow(ControlFailure)
    const client = createControlClient(origin, { fetch: fetcher })
    await expect(client.enroll({ ...enrollment, hostname: '-bad' }, key)).rejects.toMatchObject({
      code: 'bad-request',
    })
    await expect(client.poll('bad', publicKey, key)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(client.poll(hostId, 'bad', key)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(client.self('bad', key)).rejects.toMatchObject({ code: 'bad-request' })
    expect(() => client.heartbeat('bad', key, heartbeat)).toThrow(ControlFailure)
    expect(() => client.heartbeat(hostId, key, { ...heartbeat, seq: -1 })).toThrow(ControlFailure)
    expect(() => client.revoke('bad', key)).toThrow(ControlFailure)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('gives 410 precedence over headers and malformed or oversized bodies and cancels without reading', async () => {
    const cancel = vi.fn(() => {
      throw new Error('private cancel error')
    })
    const response = new Response(new ReadableStream({ cancel }), {
      status: 410,
      headers: { 'content-length': '999999', 'content-type': 'text/html' },
    })
    await expect(clientWith(response).self(hostId, key)).rejects.toMatchObject({ code: 'gone' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('accepts only an empty 204 for revoke including zero-byte streams and strict framing', async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      new Response(null, { status: 204, headers: { 'content-length': '0' } }),
      body204(''),
    ])
      await expect(clientWith(response).revoke(hostId, key)).resolves.toBeUndefined()
    for (const response of [
      Response.json({}),
      body204('x'),
      new Response(null, { status: 204, headers: { 'content-length': '00' } }),
      new Response(null, { status: 204, headers: { 'transfer-encoding': 'chunked' } }),
    ])
      await expect(clientWith(response).revoke(hostId, key)).rejects.toMatchObject({
        code: 'internal',
      })
    await expect(
      clientWith(new Response(null, { status: 204 })).self(hostId, key),
    ).rejects.toMatchObject({ code: 'internal' })
  })

  it.each([
    [
      'invalid UTF-8',
      () =>
        new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    ],
    ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
    ['wrong media type', () => new Response(JSON.stringify(self))],
    [
      'media type suffix',
      () =>
        new Response(JSON.stringify(self), { headers: { 'content-type': 'application/jsonx' } }),
    ],
    ['wrong success status', () => Response.json(self, { status: 201 })],
    ['invalid shape', () => Response.json({ ...self, hostId: 'bad' })],
    ['wrong host', () => Response.json({ ...self, hostId: hostId.replace(/00$/, '01') })],
    ['missing body', () => new Response(null)],
    [
      'mismatched error status',
      () => Response.json({ error: { code: 'forbidden', message: 'secret' } }, { status: 401 }),
    ],
  ])('maps %s to internal', async (_name, response) => {
    await expect(clientWith(response()).self(hostId, key)).rejects.toMatchObject({
      code: 'internal',
    })
  })

  it('accepts case-insensitive JSON with parameters and the inclusive 64KiB cap, not one extra byte', async () => {
    const text = JSON.stringify(self)
    await expect(
      clientWith(
        new Response(text + ' '.repeat(65536 - Buffer.byteLength(text)), {
          headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        }),
      ).self(hostId, key),
    ).resolves.toEqual(self)
    await expect(
      clientWith(new Response(' '.repeat(65537))).self(hostId, key),
    ).rejects.toMatchObject({ code: 'payload-too-large' })
  })

  it.each(Object.entries(CONTROL_ERROR_STATUS) as Array<[ControlErrorCode, number]>)(
    'maps valid %s errors without server messages',
    async (code, status) => {
      await expect(
        clientWith(
          Response.json({ error: { code, message: 'private server secret' } }, { status }),
        ).self(hostId, key),
      ).rejects.toMatchObject({ code, message: expect.not.stringContaining('private') })
    },
  )

  it.each([400, 429, 500, 502, 503, 504])(
    'maps broken error bodies by status %s',
    async (status) => {
      for (const response of [
        new Response(null, { status }),
        new Response('secret HTML', { status }),
        new Response('{', { status, headers: { 'content-type': 'application/json' } }),
        Response.json({ secret: 'wrong shape' }, { status }),
      ])
        await expect(clientWith(response).self(hostId, key)).rejects.toMatchObject({
          code: status === 429 ? 'too-many-requests' : status >= 500 ? 'unavailable' : 'internal',
          message: expect.not.stringContaining('secret'),
        })
    },
  )

  it.each(['before fetch', 'during body', 'timeout fetch', 'timeout body'])(
    'composes cancellation %s and removes timers and caller listeners',
    async (mode) => {
      vi.useFakeTimers()
      const caller = new AbortController()
      const add = vi.spyOn(caller.signal, 'addEventListener')
      const remove = vi.spyOn(caller.signal, 'removeEventListener')
      const log = vi.fn()
      if (mode === 'before fetch') caller.abort()
      const client = createControlClient(origin, {
        signal: caller.signal,
        log,
        fetch: async (_url, init) => {
          const signal = init?.signal
          if (signal?.aborted) throw new DOMException('private secret', 'AbortError')
          if (mode.endsWith('body'))
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal?.addEventListener('abort', () =>
                    controller.error(new DOMException('private secret', 'AbortError')),
                  )
                },
              }),
            )
          return new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new TypeError('private secret'))),
          )
        },
      })
      const pending = expect(client.self(hostId, key)).rejects.toMatchObject({
        code: 'offline',
        message: 'The control plane could not be reached.',
      })
      await Promise.resolve()
      if (mode === 'during body') caller.abort()
      if (mode.startsWith('timeout')) await vi.advanceTimersByTimeAsync(10_000)
      await pending
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
      expect(vi.getTimerCount()).toBe(0)
      expect(log).toHaveBeenCalledOnce()
      expect(JSON.stringify(log.mock.calls)).not.toContain('private secret')
    },
  )

  it('logs exactly one safe trace record with sanitized request IDs, elapsed time and heartbeat sequence', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const now = vi
      .fn()
      .mockReturnValueOnce(1792000000100)
      .mockReturnValueOnce(1792000000100)
      .mockReturnValueOnce(1792000000099)
    const client = createControlClient(origin, {
      trace,
      now,
      log,
      fetch: async () =>
        Response.json(
          { accepted: true, nextInSec: 30 },
          { headers: { 'x-request-id': '1'.repeat(32) } },
        ),
    })
    await client.heartbeat(hostId, key, heartbeat)
    expect(log.mock.calls).toEqual([
      [
        'control',
        'call',
        {
          method: 'POST',
          route: CONTROL_ROUTES.hostHeartbeat,
          status: 200,
          ms: 0,
          requestId: '1'.repeat(32),
          trace,
          code: null,
          seq: 7,
        },
      ],
    ])
    expect(vi.getTimerCount()).toBe(0)
    log.mockClear()
    const invalidTrace = 'private secret'
    await expect(
      createControlClient(origin, {
        trace: invalidTrace,
        log,
        fetch: async () =>
          Response.json(
            { error: { code: 'unavailable', message: invalidTrace } },
            { status: 503, headers: { 'x-request-id': invalidTrace } },
          ),
      }).self(hostId, key),
    ).rejects.toBeInstanceOf(ControlFailure)
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'control',
      'call',
      expect.objectContaining({
        code: 'unavailable',
        status: 503,
        requestId: null,
        trace: expect.stringMatching(/^[0-9a-f]{16}$/),
      }),
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain(invalidTrace)
    expect(vi.getTimerCount()).toBe(0)
  })
})
