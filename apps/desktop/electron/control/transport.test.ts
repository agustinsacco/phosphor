import { describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ROUTES,
  DEFAULT_CONTROL_URL,
  parseMachinesResponse,
  type Parsed,
} from '@shared/control-api'
import { controlFailure, createControlTransport } from './transport'

const machines = { machines: [], serverTime: '2026-01-01T00:00:00.000Z' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const empty = (body: unknown): Parsed<Record<never, never>> =>
  body === null ? { ok: true, value: {} } : { ok: false, reason: 'body' }
function harness() {
  const fetchImpl = vi.fn<typeof fetch>(async () => json(machines))
  const log = vi.fn()
  const onUnauthorized = vi.fn()
  const version = vi.fn(() => '1.2.3')
  const request = createControlTransport(
    {
      baseUrl: () => DEFAULT_CONTROL_URL,
      fetch: fetchImpl,
      log,
      now: () => 1,
      version,
    },
    onUnauthorized,
  )
  return {
    fetchImpl,
    log,
    onUnauthorized,
    version,
    request,
    list: () =>
      request(
        'secret-token',
        CONTROL_ROUTES.machines,
        'GET',
        parseMachinesResponse,
        undefined,
        '1'.repeat(16),
      ),
  }
}

describe('createControlTransport', () => {
  it('omits ambient credentials, forbids redirects and binds safe headers and a ten-second signal', async () => {
    const h = harness()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      expect(await h.list()).toEqual({ ok: true, ...machines })
      expect(h.fetchImpl.mock.calls[0]).toEqual([
        new URL(CONTROL_ROUTES.machines, DEFAULT_CONTROL_URL),
        expect.objectContaining({
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          signal: expect.any(AbortSignal),
          headers: {
            authorization: 'Bearer secret-token',
            accept: 'application/json',
            'x-phosphor-client': 'desktop/1.2.3',
            'x-phosphor-trace': '1'.repeat(16),
          },
          body: undefined,
        }),
      ])
      expect(timeout).toHaveBeenCalledWith(10_000)
    } finally {
      timeout.mockRestore()
    }
    h.version.mockReturnValue('invalid/version')
    await h.list()
    expect(new Headers(h.fetchImpl.mock.calls[1]?.[1]?.headers).get('x-phosphor-client')).toBe(
      'desktop/0.0.0',
    )
  })

  it('serializes request bodies as JSON only when supplied', async () => {
    const h = harness()
    await h.request('token', '/endpoint', 'POST', parseMachinesResponse, { label: 'bee' }, 'trace')
    expect(h.fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      body: '{"label":"bee"}',
      headers: { 'content-type': 'application/json' },
    })
  })

  it('cancels 401 without reading peer bytes and tolerates cancellation failure', async () => {
    const h = harness()
    const cancel = vi.fn(() => {
      expect(h.onUnauthorized).toHaveBeenCalledOnce()
      throw new Error('peer-secret')
    })
    h.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 401 }))
    expect(await h.list()).toEqual(controlFailure('signed-out'))
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.fetchImpl).toHaveBeenCalledOnce()
    expect(h.log).toHaveBeenLastCalledWith(
      'control',
      'call',
      expect.objectContaining({ status: 401, code: 'unauthenticated' }),
    )
  })

  it('bounds cumulative bytes rather than individual chunks and fails closed if cancellation rejects', async () => {
    for (const size of [64 * 1024, 64 * 1024 + 1]) {
      const h = harness()
      const cancel = vi.fn(() => {
        throw new Error('cancel-secret')
      })
      h.fetchImpl.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              const raw = JSON.stringify(machines).padEnd(size, ' ')
              controller.enqueue(new TextEncoder().encode(raw.slice(0, 32 * 1024)))
              controller.enqueue(new TextEncoder().encode(raw.slice(32 * 1024)))
              if (size === 64 * 1024) controller.close()
            },
            cancel,
          }),
        ),
      )
      expect(await h.list()).toEqual(
        size === 64 * 1024 ? { ok: true, ...machines } : controlFailure('internal'),
      )
      expect(cancel).toHaveBeenCalledTimes(size === 64 * 1024 ? 0 : 1)
    }
  })

  it('rejects malformed JSON, invalid payloads and non-200 GET success', async () => {
    for (const response of [
      new Response('{'),
      json({}),
      json(machines, 201),
      new Response(null, { status: 204 }),
    ]) {
      const h = harness()
      h.fetchImpl.mockResolvedValueOnce(response)
      expect(await h.list()).toEqual(controlFailure('internal'))
    }
  })

  it('accepts only empty 204 DELETE responses', async () => {
    const h = harness()
    const remove = () => h.request('token', '/machine', 'DELETE', empty, undefined, 'trace')
    h.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await remove()).toEqual({ ok: true })
    const nonempty = new Response(null, { status: 204 })
    Object.defineProperty(nonempty, 'body', {
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('null'))
          controller.close()
        },
      }),
    })
    for (const response of [new Response(null), json(null), nonempty]) {
      h.fetchImpl.mockResolvedValueOnce(response)
      expect(await remove()).toEqual(controlFailure('internal'))
    }
  })

  it('returns fixed errors and rejects unknown and inherited peer codes', async () => {
    const h = harness()
    for (const code of ['conflict', 'unknown', 'constructor', 'toString']) {
      h.fetchImpl.mockResolvedValueOnce(json({ error: { code, message: 'peer-secret' } }, 409))
      expect(await h.list()).toEqual(controlFailure(code === 'conflict' ? 'conflict' : 'internal'))
    }
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('peer-secret')
  })

  it('logs only fixed network classes, never exception names, messages or tokens', async () => {
    const h = harness()
    for (const error of [
      new TypeError('secret'),
      new DOMException('secret', 'AbortError'),
      new DOMException('secret', 'TimeoutError'),
      new DOMException('secret', 'secret-name'),
      new Error('secret'),
    ]) {
      h.fetchImpl.mockRejectedValueOnce(error)
      expect(await h.list()).toEqual(controlFailure('offline'))
    }
    expect(h.log.mock.calls.map(([, , data]) => data.code)).toEqual([
      'TypeError',
      'AbortError',
      'TimeoutError',
      'Error',
      'Error',
    ])
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('secret')
  })

  it('redacts machine route IDs and validates request IDs', async () => {
    const h = harness()
    for (const requestId of ['1'.repeat(32), 'secret-peer-id']) {
      h.fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify(machines), { headers: { 'x-request-id': requestId } }),
      )
      await h.request(
        'secret-token',
        `${CONTROL_ROUTES.machines}/private-id`,
        'PATCH',
        parseMachinesResponse,
        undefined,
        'trace',
      )
      expect(h.log).toHaveBeenLastCalledWith('control', 'call', {
        method: 'PATCH',
        route: CONTROL_ROUTES.machines + '/:id',
        status: 200,
        requestId: requestId === 'secret-peer-id' ? null : requestId,
        ms: 0,
        trace: 'trace',
        code: null,
      })
    }
    for (const secret of ['secret-token', 'private-id', 'secret-peer-id'])
      expect(JSON.stringify(h.log.mock.calls)).not.toContain(secret)
  })
})
