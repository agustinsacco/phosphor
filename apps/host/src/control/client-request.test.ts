import { createHash, createPublicKey, verify } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ROUTES,
  HOST_HEADERS,
  hostSigningString,
  type Parsed,
} from '@phosphor/shared/control-api'
import { ControlFailure } from './client'
import { executeRequest, type ClientState, type RequestArgs } from './client-request'
import { freshKey, publicIdentity, type SigningIdentity } from './signer'

const key = freshKey()
const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
const trace = '0123456789abcdef'
const parse = (value: unknown): Parsed<unknown> => ({ ok: true, value })
const args: RequestArgs<unknown> = {
  method: 'GET',
  path: CONTROL_ROUTES.hostSelf,
  key,
  identity: { hostId },
  body: '',
  parse,
}
const state = (ports: ClientState['ports']): ClientState => ({
  url: 'https://example.com',
  trace,
  ports,
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('signed control request execution', () => {
  it.each(['GET', 'POST'] as const)(
    'signs exact %s inputs and forbids redirects',
    async (method) => {
      const body = method === 'POST' ? '{"text":"é"}' : ''
      const identity: SigningIdentity =
        method === 'GET' ? { hostId } : { publicKey: publicIdentity(key).publicKey }
      const path = method === 'GET' ? CONTROL_ROUTES.hostSelf : CONTROL_ROUTES.enrollments
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        expect(url).toBe(`https://example.com${path}`)
        expect(init?.method).toBe(method)
        expect(init?.redirect).toBe('error')
        expect(init?.body).toBe(method === 'POST' ? body : undefined)
        const headers = new Headers(init?.headers)
        expect(Array.from(headers.keys())).toHaveLength(7)
        expect(headers.get('content-type')).toBe('application/json')
        expect(headers.get('x-phosphor-client')).toBe('host/0.0.0-dev.source')
        expect(headers.get('x-phosphor-trace')).toBe(trace)
        const id = 'hostId' in identity ? identity.hostId : identity.publicKey
        expect(headers.get('hostId' in identity ? HOST_HEADERS.host : HOST_HEADERS.key)).toBe(id)
        expect(headers.get(HOST_HEADERS.timestamp)).toBe('1792000000')
        expect(headers.get(HOST_HEADERS.nonce)).toBe('BwcHBwcHBwcHBwcHBwcHBw')
        const signed = hostSigningString({
          method,
          path,
          identity: id,
          timestamp: '1792000000',
          nonce: 'BwcHBwcHBwcHBwcHBwcHBw',
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
        return Response.json({ accepted: true })
      })
      await expect(
        executeRequest(
          state({ fetch: fetcher, now: () => 1792000000000, random: () => Buffer.alloc(16, 7) }),
          { ...args, method, path, identity, body },
        ),
      ).resolves.toEqual({ accepted: true })
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )

  it('cleans up listeners and timer after success and logs one safe record including sequence', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const add = vi.spyOn(caller.signal, 'addEventListener')
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    const log = vi.fn()
    const now = vi
      .fn()
      .mockReturnValueOnce(1792000000000)
      .mockReturnValueOnce(1792000000000)
      .mockReturnValueOnce(1792000000007)
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({}, { headers: { 'x-request-id': 'a'.repeat(32) } }),
    )
    await executeRequest(state({ fetch: fetcher, now, log, signal: caller.signal }), {
      ...args,
      seq: 9,
    })
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]?.[1])
    expect(vi.getTimerCount()).toBe(0)
    expect(log.mock.calls).toEqual([
      [
        'control',
        'call',
        {
          method: 'GET',
          route: args.path,
          status: 200,
          ms: 7,
          requestId: 'a'.repeat(32),
          trace,
          code: null,
          seq: 9,
        },
      ],
    ])
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    caller.abort()
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signal?.aborted).toBe(false)
  })

  it.each(['pre-aborted', 'caller abort', 'timeout fetch', 'timeout read'])(
    'keeps the composed signal alive through response parsing: %s',
    async (mode) => {
      vi.useFakeTimers()
      const caller = new AbortController()
      const remove = vi.spyOn(caller.signal, 'removeEventListener')
      const log = vi.fn()
      if (mode === 'pre-aborted') caller.abort()
      const fetcher: typeof fetch = async (_url, init) => {
        const fail = () => new DOMException('private transport message', 'AbortError')
        if (init?.signal?.aborted) throw fail()
        if (mode === 'timeout read')
          return new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(fail()))
              },
            }),
          )
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(fail())),
        )
      }
      const pending = expect(
        executeRequest(state({ fetch: fetcher, log, signal: caller.signal }), args),
      ).rejects.toMatchObject({
        code: 'offline',
        message: 'The control plane could not be reached.',
      })
      await Promise.resolve()
      if (mode === 'caller abort') caller.abort()
      if (mode.startsWith('timeout')) {
        await vi.advanceTimersByTimeAsync(9999)
        expect(log).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
      }
      await pending
      expect(remove).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      expect(log).toHaveBeenCalledExactlyOnceWith(
        'control',
        'call',
        expect.objectContaining({
          code: 'AbortError',
          status: mode === 'timeout read' ? 200 : 0,
        }),
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    },
  )

  it('uses the per-request signal instead of the client default signal', async () => {
    const defaultCaller = new AbortController()
    defaultCaller.abort()
    const caller = new AbortController()
    const addDefault = vi.spyOn(defaultCaller.signal, 'addEventListener')
    await expect(
      executeRequest(
        state({
          signal: defaultCaller.signal,
          fetch: async (_url, init) => {
            expect(init?.signal?.aborted).toBe(false)
            return Response.json({})
          },
        }),
        { ...args, signal: caller.signal },
      ),
    ).resolves.toEqual({})
    expect(addDefault).not.toHaveBeenCalled()
  })

  it.each([
    [new TypeError('private transport'), 'TypeError'],
    [new DOMException('private abort', 'AbortError'), 'AbortError'],
    [new DOMException('private timeout', 'TimeoutError'), 'TimeoutError'],
    [new DOMException('private other', 'SecurityError'), 'Error'],
    [new Error('private error'), 'Error'],
    ['private non-error', 'Error'],
  ])('normalizes transport failures and logs only their class %#', async (error, code) => {
    vi.useFakeTimers()
    const log = vi.fn()
    await expect(
      executeRequest(
        state({
          log,
          fetch: async () => {
            throw error
          },
        }),
        args,
      ),
    ).rejects.toMatchObject({ code: 'offline', message: 'The control plane could not be reached.' })
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'control',
      'call',
      expect.objectContaining({ status: 0, code }),
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('normalizes signing failures before fetch and still runs cleanup and logging', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>()
    const log = vi.fn()
    await expect(
      executeRequest(state({ fetch: fetcher, log, random: () => new Uint8Array(1) }), args),
    ).rejects.toMatchObject({ code: 'offline' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'control',
      'call',
      expect.objectContaining({ status: 0, code: 'Error' }),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains policy failures, sanitizes request IDs and clamps elapsed time', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const now = vi
      .fn()
      .mockReturnValueOnce(1792000000000)
      .mockReturnValueOnce(1792000000000)
      .mockReturnValueOnce(1791999999999)
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    await expect(
      executeRequest(
        state({
          log,
          now,
          signal: caller.signal,
          fetch: async () =>
            Response.json(
              { error: { code: 'unavailable', message: 'private server message' } },
              { status: 503, headers: { 'x-request-id': 'private untrusted ID' } },
            ),
        }),
        args,
      ),
    ).rejects.toBeInstanceOf(ControlFailure)
    expect(log.mock.calls).toEqual([
      [
        'control',
        'call',
        {
          method: 'GET',
          route: args.path,
          status: 503,
          ms: 0,
          requestId: null,
          trace,
          code: 'unavailable',
        },
      ],
    ])
    expect(remove).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
