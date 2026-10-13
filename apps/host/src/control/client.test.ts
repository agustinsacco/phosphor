import { createHash, createPublicKey, verify } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ROUTES,
  HOST_HEADERS,
  hostSigningString,
  type ControlErrorCode,
} from '@phosphor/shared/control-api'
import { createControlClient } from './client'
import { freshKey, publicIdentity } from './signer'

const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const self = {
  hostId,
  label: 'bee1',
  owner: { login: 'me' },
  enrolledAt: '2026-10-10T00:00:00.000Z',
  lastSeenAt: null,
}
const key = freshKey()
const { publicKey } = publicIdentity(key)
const json = (value: unknown, status = 200) => Response.json(value, { status })
afterEach(() => vi.useRealTimers())
const clientWith = (response: Response) =>
  createControlClient('https://example.com', { fetch: async () => response })

describe('signed control client', () => {
  it('sends signing and trace headers correctly in both modes and signs exact request bytes', async () => {
    const calls: string[] = []
    const client = createControlClient('https://example.com', {
      now: () => 1792000000000,
      random: () => Buffer.alloc(16, 7),
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname
        calls.push(path)
        const headers = new Headers(init?.headers)
        expect(Array.from(headers.keys())).toHaveLength(7)
        expect(headers.get('x-phosphor-client')).toBe('host/0.0.0-dev.source')
        expect(headers.get('x-phosphor-trace')).toMatch(/^[0-9a-f]{16}$/)
        expect(headers.get('content-type')).toBe('application/json')
        const enrolling = path.startsWith(CONTROL_ROUTES.enrollments)
        expect(headers.get(enrolling ? HOST_HEADERS.key : HOST_HEADERS.host)).toBe(
          enrolling ? publicKey : hostId,
        )
        expect(headers.get(enrolling ? HOST_HEADERS.host : HOST_HEADERS.key)).toBeNull()
        expect(headers.get(HOST_HEADERS.timestamp)).toBe('1792000000')
        expect(headers.get(HOST_HEADERS.nonce)).toBe('BwcHBwcHBwcHBwcHBwcHBw')
        expect(init?.redirect).toBe('error')
        const body = typeof init?.body === 'string' ? init.body : ''
        const signed = hostSigningString({
          method: init?.method ?? '',
          path,
          identity: enrolling ? publicKey : hostId,
          timestamp: headers.get(HOST_HEADERS.timestamp) ?? '',
          nonce: headers.get(HOST_HEADERS.nonce) ?? '',
          bodySha256: createHash('sha256').update(body).digest('hex'),
        })
        expect(
          verify(
            null,
            Buffer.from(signed),
            createPublicKey(key),
            Buffer.from(headers.get(HOST_HEADERS.signature) ?? '', 'base64url'),
          ),
        ).toBe(true)
        if (path === CONTROL_ROUTES.hostSelf) {
          expect(init?.body).toBeUndefined()
          return json(self)
        }
        if (path === CONTROL_ROUTES.hostRevoke) {
          expect(body).toBe('{}')
          return new Response(null, { status: 204 })
        }
        if (path === CONTROL_ROUTES.enrollmentPoll) return json({ status: 'pending' })
        return json({
          enrollmentId: hostId,
          userCode: 'BCDFGHJK',
          keyFingerprint: publicIdentity(key).keyFingerprint,
          expiresAt: '2026-10-10T00:10:00.000Z',
          pollIntervalSec: 5,
        })
      },
    })
    await client.enroll(
      { publicKey, hostname: 'bee1', platform: 'linux', arch: 'x64', hostVersion: '1.0.0' },
      key,
    )
    await client.poll(hostId, publicKey, key)
    await client.self(hostId, key)
    await client.revoke(hostId, key)
    expect(calls).toEqual([
      CONTROL_ROUTES.enrollments,
      CONTROL_ROUTES.enrollmentPoll,
      CONTROL_ROUTES.hostSelf,
      CONTROL_ROUTES.hostRevoke,
    ])
  })
  it.each([
    [json({ ...self, hostId: 'bad' }), 'internal'],
    [json({ ...self, hostId: hostId.replace(/00$/, '01') }), 'internal'],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), 'internal'],
    [new Response(JSON.stringify(self)), 'internal'],
    [new Response(null, { status: 204 }), 'internal'],
    [json(self, 201), 'internal'],
    [json({ error: { code: 'constructor', message: 'hidden' } }, 400), 'internal'],
    [json({ error: { code: 'forbidden', message: 'hidden' } }, 401), 'internal'],
    [new Response('hidden', { status: 410 }), 'gone'],
  ])('rejects invalid response %#', async (response, code) => {
    await expect(clientWith(response).self(hostId, key)).rejects.toMatchObject({ code })
  })
  it.each<ControlErrorCode>([
    'bad-request',
    'unauthenticated',
    'forbidden',
    'not-found',
    'conflict',
    'gone',
    'payload-too-large',
    'unsupported-media-type',
    'too-many-requests',
    'internal',
    'unavailable',
  ])('maps %s without exposing server text', async (code) => {
    const statuses = {
      'bad-request': 400,
      unauthenticated: 401,
      forbidden: 403,
      'not-found': 404,
      conflict: 409,
      gone: 410,
      'payload-too-large': 413,
      'unsupported-media-type': 415,
      'too-many-requests': 429,
      internal: 500,
      unavailable: 503,
    }
    await expect(
      clientWith(json({ error: { code, message: 'PRIVATE SECRET HEADERS' } }, statuses[code])).self(
        hostId,
        key,
      ),
    ).rejects.toMatchObject({ code, message: expect.not.stringContaining('PRIVATE SECRET') })
  })
  it('caps response bytes at 64 KiB inclusive', async () => {
    const text = JSON.stringify(self)
    await expect(
      clientWith(
        new Response(text + ' '.repeat(65536 - Buffer.byteLength(text)), {
          headers: { 'content-type': 'application/json' },
        }),
      ).self(hostId, key),
    ).resolves.toEqual(self)
    await expect(
      clientWith(new Response(' '.repeat(65537))).self(hostId, key),
    ).rejects.toMatchObject({ code: 'payload-too-large' })
  })
  it('rejects malformed approvals and create responses', async () => {
    await expect(
      clientWith(
        json({ status: 'approved', hostId: 'bad', label: 'bee1', owner: { login: 'me' } }),
      ).poll(hostId, publicKey, key),
    ).rejects.toMatchObject({ code: 'internal' })
    await expect(
      clientWith(
        json({
          enrollmentId: hostId,
          userCode: 'BCDFGHJK',
          keyFingerprint: 'bad',
          expiresAt: '2026-10-10T00:00:00Z',
          pollIntervalSec: 0,
        }),
      ).enroll(
        { publicKey, hostname: 'bee1', platform: 'linux', arch: 'x64', hostVersion: '1.0.0' },
        key,
      ),
    ).rejects.toMatchObject({ code: 'internal' })
  })
  it('requires exactly 204 and zero bytes for revoke', async () => {
    await expect(clientWith(json({})).revoke(hostId, key)).rejects.toMatchObject({
      code: 'internal',
    })
    await expect(
      clientWith(new Response(null, { status: 204 })).revoke(hostId, key),
    ).resolves.toBeUndefined()
    for (const headers of [{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }]) {
      await expect(
        clientWith(new Response(null, { status: 204, headers })).revoke(hostId, key),
      ).rejects.toMatchObject({ code: 'internal' })
    }
    await expect(
      clientWith(new Response(null, { status: 204, headers: { 'content-length': '0' } })).revoke(
        hostId,
        key,
      ),
    ).resolves.toBeUndefined()
    // Fetch normally forbids a body on 204; a transport port can still return one.
    const withBody = new Response('x')
    Object.defineProperty(withBody, 'status', { value: 204 })
    await expect(clientWith(withBody).revoke(hostId, key)).rejects.toMatchObject({
      code: 'internal',
    })
    const emptyBody = new Response('')
    Object.defineProperty(emptyBody, 'status', { value: 204 })
    await expect(clientWith(emptyBody).revoke(hostId, key)).resolves.toBeUndefined()
  })
  it('validates inputs and refuses non-origin control URLs before network I/O', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = createControlClient('https://example.com', { fetch: fetcher })
    await expect(client.self('bad', key)).rejects.toMatchObject({ code: 'bad-request' })
    expect(() => client.revoke('bad', key)).toThrow()
    await expect(client.poll(hostId, 'a'.repeat(43), key)).rejects.toMatchObject({
      code: 'bad-request',
    })
    await expect(
      client.enroll(
        { publicKey, hostname: '-bee1', platform: 'linux', arch: 'x64', hostVersion: '1.0.0' },
        key,
      ),
    ).rejects.toMatchObject({ code: 'bad-request' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(() => createControlClient('http://public.example')).toThrow()
    expect(() => createControlClient('https://example.com?secret=x')).toThrow()
  })
  it('aborts fetch and body reads after 10 seconds and supports cancellation', async () => {
    vi.useFakeTimers()
    for (const streaming of [false, true]) {
      const client = createControlClient('https://example.com', {
        fetch: async (_url, init) => {
          if (streaming)
            return new Response(
              new ReadableStream({
                start(controller) {
                  init?.signal?.addEventListener('abort', () =>
                    controller.error(new Error('secret')),
                  )
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          return new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('secret'))),
          )
        },
      })
      const promise = expect(client.self(hostId, key)).rejects.toMatchObject({
        code: 'offline',
        message: 'The control plane could not be reached.',
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await promise
    }
    const abort = new AbortController()
    const fetcher: typeof fetch = async (_url, init) => {
      if (init?.signal?.aborted) throw new Error('secret')
      return json(self)
    }
    abort.abort()
    await expect(
      createControlClient('https://example.com', { fetch: fetcher, signal: abort.signal }).self(
        hostId,
        key,
      ),
    ).rejects.toMatchObject({ code: 'offline' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([429, 500, 502, 503, 504, 400])(
    'maps malformed error responses by status %s without echoing bytes',
    async (status) => {
      for (const response of [
        new Response('private HTML', { status }),
        new Response('private malformed', {
          status,
          headers: { 'content-type': 'application/json' },
        }),
        Response.json({ unexpected: 'private shape' }, { status }),
        new Response(null, { status }),
      ])
        await expect(clientWith(response).self(hostId, key)).rejects.toMatchObject({
          code: status === 429 ? 'too-many-requests' : status >= 500 ? 'unavailable' : 'internal',
          message: expect.not.stringContaining('private'),
        })
    },
  )
})

it('logs error codes and network classes, but never peer messages or a malformed request id', async () => {
  const secret = crypto.randomUUID()
  const log = vi.fn()
  const client = createControlClient('https://example.com', {
    log,
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: 'unavailable', message: secret } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': secret },
      }),
  })
  await expect(client.self(hostId, key)).rejects.toMatchObject({ code: 'unavailable' })
  expect(log).toHaveBeenLastCalledWith(
    'control',
    'call',
    expect.objectContaining({ code: 'unavailable', status: 503, requestId: null }),
  )
  const offline = createControlClient('https://example.com', {
    log,
    fetch: async () => {
      throw new TypeError(secret)
    },
  })
  await expect(offline.self(hostId, key)).rejects.toMatchObject({ code: 'offline' })
  expect(log).toHaveBeenLastCalledWith(
    'control',
    'call',
    expect.objectContaining({ code: 'TypeError', status: 0, requestId: null }),
  )
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
})
