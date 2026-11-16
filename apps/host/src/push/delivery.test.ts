import { createECDH } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPushDelivery, type PushMessage } from './delivery'

const agent = createECDH('prime256v1')
agent.generateKeys()
const keys = { p256dh: agent.getPublicKey().toString('base64url'), auth: 'EAY5CR185BofDMFkvMZw4Q' }
const FCM = 'https://fcm.googleapis.com/fcm/send/device'
const message = (overrides: Partial<PushMessage> = {}): PushMessage => ({
  subscription: { endpoint: FCM, keys },
  payload: Buffer.from('{"v":1}'),
  ttl: 21_600,
  urgency: 'normal',
  topic: 'lane-topic',
  ...overrides,
})

function setup(answers: (() => Promise<Response>)[] = []) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      (await answers.shift()?.()) ?? new Response(null, { status: 201 }),
  )
  const gone = vi.fn()
  const log = vi.fn()
  const delivery = createPushDelivery({
    fetch: fetch as unknown as typeof globalThis.fetch,
    authorization: () => 'vapid t=token, k=key',
    gone,
    now: () => Date.now(),
    log,
  })
  return { fetch, gone, log, delivery }
}
const status = (code: number, headers?: Record<string, string>) => () =>
  Promise.resolve(new Response(null, { status: code, headers }))

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('push delivery', () => {
  it('posts one encrypted record with the RFC 8030 headers, never following redirects', async () => {
    const t = setup()
    t.delivery.send(message({ urgency: 'high' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = t.fetch.mock.calls[0]!
    expect(url).toBe(FCM)
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: 'vapid t=token, k=key',
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '21600',
        urgency: 'high',
        topic: 'lane-topic',
      },
    })
    const body = init!.body as Buffer
    expect(body.readUInt32BE(16)).toBe(4096)
    expect(body.includes(Buffer.from('{"v":1}'))).toBe(false)
  })
  it('only queues on send: the caller returns before any request starts', () => {
    const t = setup()
    t.delivery.send(message())
    expect(t.fetch).not.toHaveBeenCalled()
    expect(t.delivery.pending()).toBe(1)
  })
  it('forgets a subscription the push service says is gone, with its queued messages', async () => {
    for (const code of [404, 410]) {
      const t = setup([status(code)])
      t.delivery.send(message({ topic: 'a' }))
      await vi.advanceTimersByTimeAsync(0)
      t.delivery.send(message({ topic: 'b' }))
      expect(t.gone).toHaveBeenCalledWith(FCM)
      await vi.advanceTimersByTimeAsync(0)
      expect(t.fetch).toHaveBeenCalledTimes(2)
    }
  })
  it('retries 429 and 5xx with bounded backoff, honouring a longer Retry-After', async () => {
    const t = setup([status(429, { 'retry-after': '60' }), status(503), status(500), status(502)])
    t.delivery.send(message())
    await vi.advanceTimersByTimeAsync(0)
    expect(t.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(t.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.fetch).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(t.fetch).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(t.fetch).toHaveBeenCalledTimes(4)
    expect(t.log).toHaveBeenLastCalledWith('push.failed', { reason: 502 })
    expect(t.delivery.pending()).toBe(0)
  })
  it('caps a Retry-After at ten minutes and retries a network failure', async () => {
    const t = setup([status(503, { 'retry-after': '86400' }), () => Promise.reject(new Error('x'))])
    t.delivery.send(message())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(t.fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.fetch).toHaveBeenCalledTimes(3)
  })
  it('drops a refusal without retrying, logging only its status', async () => {
    const t = setup([status(400), status(403)])
    t.delivery.send(message({ topic: 'a' }))
    t.delivery.send(message({ topic: 'b' }))
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(t.fetch).toHaveBeenCalledTimes(2)
    expect(t.log.mock.calls).toStrictEqual([
      ['push.refused', { status: 400 }],
      ['push.refused', { status: 403 }],
    ])
  })
  it('re-checks the endpoint at send time and never contacts anything else', async () => {
    const t = setup()
    for (const endpoint of ['https://evil.example/push', 'http://fcm.googleapis.com/x'])
      t.delivery.send(message({ subscription: { endpoint, keys }, topic: endpoint }))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.fetch).not.toHaveBeenCalled()
    expect(t.log).toHaveBeenCalledWith('push.refused', {})
  })
  it('keeps one waiting message per device and lane, and bounds the queue', async () => {
    const hang = () => new Promise<Response>(() => {})
    const t = setup([hang, hang, hang, hang])
    for (let i = 0; i < 4; i++) t.delivery.send(message({ topic: `busy-${i}` }))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.fetch).toHaveBeenCalledTimes(4)
    t.delivery.send(message({ topic: 'lane', payload: Buffer.from('old') }))
    t.delivery.send(message({ topic: 'lane', payload: Buffer.from('new') }))
    expect(t.delivery.pending()).toBe(5)
    for (let i = 0; i < 70; i++) t.delivery.send(message({ topic: `other-${i}` }))
    expect(t.delivery.pending()).toBe(4 + 64)
    expect(t.log).toHaveBeenCalledWith('push.dropped', { reason: 'queue' })
    for (const call of t.log.mock.calls) expect(JSON.stringify(call)).not.toContain('fcm')
  })
  it('aborts requests in flight and sends nothing more once closed', async () => {
    let signal: AbortSignal | undefined
    const t = setup()
    t.fetch.mockImplementationOnce(async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    t.delivery.send(message())
    await vi.advanceTimersByTimeAsync(0)
    t.delivery.close()
    expect(signal?.aborted).toBe(true)
    t.delivery.send(message({ topic: 'later' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.fetch).toHaveBeenCalledTimes(1)
  })
  it('times out a request that never answers, then retries it', async () => {
    const t = setup()
    t.fetch.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    )
    t.delivery.send(message())
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.fetch).toHaveBeenCalledTimes(2)
  })
})
