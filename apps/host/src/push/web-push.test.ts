import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttentionEvent } from '@phosphor/shared/host-protocol'
import { parseWebPushPayload } from '@phosphor/shared/host-protocol-web-push'
import type { CallOutcome } from '../lanes/service'
import type { TopicFrame } from '../lanes/stream/topic'
import { decryptPushMessage, pushDevice } from './__fixtures__/device'
import { createHostWebPush, laneTopic, startHostWebPush, type WebPushOptions } from './web-push'

const HOST = '00000000-0000-4000-8000-000000000006'
const LANE = '00000000-0000-4000-8000-000000000007'
const OTHER_LANE = '00000000-0000-4000-8000-000000000008'
const THIRD_LANE = '00000000-0000-4000-8000-000000000009'
const CLIENT = '00000000-0000-4000-8000-000000000005'
const PHONE = '00000000-0000-4000-8000-000000000004'
const AT = '2026-11-15T12:00:00.000Z'
const SETTLED = Date.parse(AT)
const RECEIPT = {
  title: 'Fix the build',
  repository: 'private-repo',
  branch: 'private-branch',
  settledAt: SETTLED,
  durationMs: 65_000,
  files: 2,
  added: 3,
  removed: 1,
  tests: 'passed',
  artifacts: 0,
  excerpt: 'the private reply',
  outcome: 'done',
}
const event = (overrides: Partial<AttentionEvent> = {}): AttentionEvent => ({
  id: `${LANE}:1`,
  laneId: LANE,
  kind: 'finished',
  attention: 1,
  at: AT,
  title: 'Fix the build',
  ...overrides,
})
const vapid = () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const point = Buffer.concat([
    Buffer.of(4),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ])
  return { privateKey, publicKey: point.toString('base64url') }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-web-push-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

function setup(overrides: Partial<WebPushOptions> = {}) {
  const listeners = new Set<(frame: TopicFrame | null) => void>()
  const authorityListeners = new Set<() => void>()
  let snapshot: { owner: string; epoch: number; revokedClients: Set<string> } | null = {
    owner: 'owner',
    epoch: 1,
    revokedClients: new Set(),
  }
  const receipt = vi.fn(async (_laneId: string): Promise<CallOutcome> => ({
    ok: true,
    data: RECEIPT,
  }))
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 }),
  )
  const log = vi.fn()
  const push = createHostWebPush(
    {
      identityDirectory: dir,
      subscriptionsPath: join(dir, 'web-push.json'),
      uid: process.getuid?.(),
      hostId: HOST,
      machine: 'Studio',
      subject: 'https://control.example',
      authority: {
        snapshot: () => snapshot as never,
        onChange: (listener) => {
          authorityListeners.add(listener)
          return () => authorityListeners.delete(listener)
        },
      },
      lanesTopic: {
        listen: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      receipt,
      fetch: fetch as unknown as typeof globalThis.fetch,
      log,
      ...overrides,
    },
    vapid(),
  )
  const device = pushDevice()
  const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/phone') => ({
    endpoint,
    keys: device.keys,
  })
  return {
    push,
    receipt,
    fetch,
    log,
    device,
    subscription,
    subscribe: (client = PHONE, params: unknown = subscription()) =>
      push.feature.call('notifications.subscribe', params, undefined, client),
    publish: (attention: AttentionEvent) => {
      for (const listener of listeners)
        listener({
          type: 'attention',
          cursor: { epoch: '0123456789abcdef', seq: 1 },
          event: attention,
        })
    },
    authority: (next: typeof snapshot) => {
      snapshot = next
      for (const listener of authorityListeners) listener()
    },
    sent: () =>
      fetch.mock.calls.map(([url, init]) => ({
        url,
        headers: init!.headers as Record<string, string>,
        payload: JSON.parse(decryptPushMessage(init!.body as Buffer, device.ecdh, device.auth)),
      })),
    listeners,
  }
}
type Setup = ReturnType<typeof setup>
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('Host Web Push', () => {
  it('pushes a settled run with receipt facts only: no excerpt, repository or branch', async () => {
    const t = setup()
    expect(await t.subscribe()).toStrictEqual({ ok: true, data: null })
    t.publish(event())
    await settle()
    const [sent] = t.sent()
    expect(sent!.url).toBe('https://fcm.googleapis.com/fcm/send/phone')
    expect(sent!.payload).toStrictEqual({
      v: 1,
      hostId: HOST,
      laneId: LANE,
      kind: 'finished',
      machine: 'Studio',
      title: 'Fix the build',
      receipt: { outcome: 'done', durationMs: 65_000, files: 2, tests: 'passed', artifacts: 0 },
    })
    expect(parseWebPushPayload(sent!.payload)).toStrictEqual(sent!.payload)
    expect(JSON.stringify(sent!.payload)).not.toMatch(/private/)
    expect(sent!.headers).toMatchObject({ ttl: '21600', urgency: 'normal', topic: laneTopic(LANE) })
    expect(t.receipt).toHaveBeenCalledWith(LANE)
  })
  it('marks needs-input urgent without reading a receipt, one topic per lane', async () => {
    const t = setup()
    await t.subscribe()
    t.publish(event({ kind: 'needs-input', id: `${LANE}:2` }))
    t.publish(event({ kind: 'needs-input', laneId: OTHER_LANE, id: `${OTHER_LANE}:1` }))
    await settle()
    expect(t.receipt).not.toHaveBeenCalled()
    const sent = t.sent()
    expect(sent.map((s) => s.headers.urgency)).toStrictEqual(['high', 'high'])
    expect(sent[0]!.payload).not.toHaveProperty('receipt')
    expect(laneTopic(LANE)).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(laneTopic(LANE)).not.toBe(laneTopic(OTHER_LANE))
    expect(sent.map((s) => s.headers.topic)).toStrictEqual([laneTopic(LANE), laneTopic(OTHER_LANE)])
  })
  it('sends without receipt facts when the receipt is late, failed or for another run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const t = setup()
    await t.subscribe()
    t.receipt.mockImplementationOnce(() => new Promise(() => {}))
    t.publish(event())
    await vi.advanceTimersByTimeAsync(2_000)
    t.receipt.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x' } })
    t.publish(event({ id: `${OTHER_LANE}:1`, laneId: OTHER_LANE }))
    t.receipt.mockResolvedValueOnce({ ok: true, data: { ...RECEIPT, settledAt: SETTLED - 60_000 } })
    t.publish(event({ id: `${THIRD_LANE}:1`, laneId: THIRD_LANE }))
    await vi.advanceTimersByTimeAsync(100)
    expect(t.sent().map((s) => s.payload.receipt)).toStrictEqual([undefined, undefined, undefined])
  })
  it('never makes the lane wait: the attention listener returns before any work', () => {
    const t = setup()
    t.receipt.mockImplementation(() => new Promise(() => {}))
    t.fetch.mockImplementation(() => new Promise(() => {}))
    return t.subscribe().then(() => {
      for (let n = 0; n < 200; n++) t.publish(event({ id: `${LANE}:${n}` }))
      expect(t.fetch).not.toHaveBeenCalled()
    })
  })
  it('does no work for attention while no device is registered, nor for routines', async () => {
    const t = setup()
    t.publish(event())
    await t.subscribe()
    t.publish(event({ kind: 'routine-finished', id: 'r' }))
    await settle()
    expect(t.receipt).not.toHaveBeenCalled()
    expect(t.fetch).not.toHaveBeenCalled()
  })
  it('registers only the calling client, and only a valid allowlisted subscription', async () => {
    const t = setup()
    const call = (method: string, params: unknown, client?: string) =>
      t.push.feature.call(method, params, undefined, client)
    expect(await call('notifications.subscribe', t.subscription())).toMatchObject({
      error: { code: 'forbidden' },
    })
    for (const params of [
      t.subscription('https://evil.example/push'),
      { ...t.subscription(), clientId: CLIENT },
      { ...t.subscription(), keys: { ...t.device.keys, p256dh: 'B' + 'A'.repeat(86) } },
    ])
      expect(await t.subscribe(PHONE, params)).toMatchObject({ error: { code: 'bad-request' } })
    await t.subscribe(PHONE)
    expect(
      await call('notifications.unsubscribe', { endpoint: t.subscription().endpoint }, CLIENT),
    ).toStrictEqual({ ok: true, data: null })
    t.publish(event())
    await settle()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    await call('notifications.unsubscribe', { endpoint: t.subscription().endpoint }, PHONE)
    t.publish(event({ id: `${LANE}:2` }))
    await settle()
    expect(t.fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses to register and never pushes without a current owner and epoch', async () => {
    const t = setup()
    t.authority(null)
    expect(await t.subscribe()).toMatchObject({ error: { code: 'forbidden' } })
    t.authority({ owner: 'owner', epoch: 1, revokedClients: new Set() })
    await t.subscribe()
    t.authority(null)
    t.publish(event())
    await settle()
    expect(t.fetch).not.toHaveBeenCalled()
  })
  it('forgets revoked clients and another owner, and the endpoints a push service says are gone', async () => {
    const t = setup()
    await t.subscribe(PHONE)
    await t.subscribe(CLIENT, t.subscription('https://web.push.apple.com/tablet'))
    t.authority({ owner: 'owner', epoch: 1, revokedClients: new Set([CLIENT]) })
    expect(t.log).toHaveBeenCalledWith('push.revoked', { subscriptions: 1 })
    t.authority({ owner: 'owner', epoch: 1, revokedClients: new Set() })
    t.fetch.mockResolvedValueOnce(new Response(null, { status: 410 }))
    t.publish(event())
    await settle()
    expect(t.fetch.mock.calls.map(([url]) => url)).toStrictEqual([
      'https://fcm.googleapis.com/fcm/send/phone',
    ])
    expect(t.log).toHaveBeenCalledWith('push.gone', { subscriptions: 0 })
    await t.subscribe(PHONE)
    t.authority({ owner: 'someone-else', epoch: 1, revokedClients: new Set() })
    t.publish(event({ id: `${LANE}:2` }))
    await settle()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    for (const call of t.log.mock.calls)
      expect(JSON.stringify(call)).not.toMatch(/https|Studio|Fix/)
  })
  it.each([
    [
      'revoked',
      (t: Setup) => t.authority({ owner: 'owner', epoch: 1, revokedClients: new Set([PHONE]) }),
    ],
    [
      'unsubscribed',
      (t: Setup) =>
        t.push.feature.call(
          'notifications.unsubscribe',
          { endpoint: t.subscription().endpoint },
          undefined,
          PHONE,
        ),
    ],
    ['ownerless', (t: Setup) => t.authority(null)],
  ])('never posts a queued push to a device %s after it was queued', async (_name, invalidate) => {
    const t = setup({ delivery: { concurrency: 1 } })
    await t.subscribe()
    let release!: () => void
    t.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => (release = () => resolve(new Response(null, { status: 201 })))),
    )
    t.publish(event({ kind: 'needs-input', laneId: OTHER_LANE, id: `${OTHER_LANE}:1` }))
    await settle()
    t.publish(event({ kind: 'needs-input', id: `${LANE}:2` }))
    await settle()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    await invalidate(t)
    release()
    await settle()
    expect(t.fetch).toHaveBeenCalledTimes(1)
  })
  it('never retries a push to a device revoked after its first attempt', async () => {
    const t = setup({ delivery: { backoffMs: [10, 10, 10] } })
    await t.subscribe()
    t.fetch.mockImplementationOnce(async () => {
      t.authority({ owner: 'owner', epoch: 1, revokedClients: new Set([PHONE]) })
      return new Response(null, { status: 503 })
    })
    t.publish(event({ kind: 'needs-input' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.fetch).toHaveBeenCalledTimes(1)
  })
  it('drops an announcement a newer attention for its lane overtook while it read the receipt', async () => {
    const t = setup()
    await t.subscribe()
    let answer!: (outcome: CallOutcome) => void
    t.receipt.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    t.publish(event({ title: 'Finished run' }))
    t.publish(event({ kind: 'needs-input', id: `${LANE}:2`, title: 'Waiting run' }))
    await settle()
    answer({ ok: true, data: RECEIPT })
    await settle()
    expect(t.sent().map((s) => s.payload.kind)).toStrictEqual(['needs-input'])
  })
  it('never lets a retry of an older push replace a newer one for the same lane', async () => {
    const t = setup({ delivery: { concurrency: 1, backoffMs: [10, 10, 10] } })
    await t.subscribe()
    let fail!: () => void
    t.fetch.mockImplementationOnce(
      () => new Promise((resolve) => (fail = () => resolve(new Response(null, { status: 503 })))),
    )
    t.publish(event({ kind: 'needs-input', title: 'First' }))
    await settle()
    t.publish(event({ kind: 'needs-input', id: `${LANE}:2`, title: 'Second' }))
    await settle()
    fail()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.sent().map((s) => s.payload.title)).toStrictEqual(['First', 'Second'])
  })
  it('sends one push per device and lane at a time, so an older one never lands last', async () => {
    const t = setup()
    await t.subscribe()
    let finish!: () => void
    t.fetch.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(new Response(null, { status: 201 })))),
    )
    t.publish(event({ kind: 'needs-input', title: 'First' }))
    await settle()
    t.publish(event({ kind: 'needs-input', id: `${LANE}:2`, title: 'Second' }))
    await settle()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    finish()
    await settle()
    expect(t.sent().map((s) => s.payload.title)).toStrictEqual(['First', 'Second'])
  })
  const unsubscribe = (t: Setup) =>
    t.push.feature.call(
      'notifications.unsubscribe',
      { endpoint: t.subscription().endpoint },
      undefined,
      PHONE,
    )
  /** Fake time: one 503, so the push waits out its first backoff in the queue. */
  async function backingOff() {
    vi.useFakeTimers()
    const t = setup()
    await t.subscribe()
    t.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    t.publish(event({ kind: 'needs-input', title: 'Earlier registration' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.fetch).toHaveBeenCalledTimes(1)
    return t
  }
  it('never posts a queued push to the next registration of a device that unsubscribed', async () => {
    const t = setup({ delivery: { concurrency: 1 } })
    await t.subscribe()
    let release!: () => void
    t.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => (release = () => resolve(new Response(null, { status: 201 })))),
    )
    t.publish(event({ kind: 'needs-input', laneId: OTHER_LANE, id: `${OTHER_LANE}:1` }))
    await settle()
    t.publish(event({ kind: 'needs-input', id: `${LANE}:2`, title: 'Earlier registration' }))
    await settle()
    await unsubscribe(t)
    expect(await t.subscribe()).toStrictEqual({ ok: true, data: null })
    release()
    await settle()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    t.publish(event({ kind: 'needs-input', id: `${LANE}:3`, title: 'This registration' }))
    await settle()
    expect(t.sent().map((s) => s.payload.title)).toStrictEqual([
      'Fix the build',
      'This registration',
    ])
  })
  it('never retries a push to the registration a device made during its backoff', async () => {
    const t = await backingOff()
    await unsubscribe(t)
    await t.subscribe()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(t.fetch).toHaveBeenCalledTimes(1)
    t.publish(event({ kind: 'needs-input', id: `${LANE}:2`, title: 'This registration' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.sent().map((s) => s.payload.title)).toStrictEqual([
      'Earlier registration',
      'This registration',
    ])
  })
  it.each([
    ['a new epoch', { owner: 'owner', epoch: 2 }],
    ['another owner', { owner: 'someone-else', epoch: 2 }],
  ])(
    'never sends a push queued before %s to the device registering again under it',
    async (_name, next) => {
      const t = await backingOff()
      t.authority({ ...next, revokedClients: new Set() })
      expect(await t.subscribe()).toStrictEqual({ ok: true, data: null })
      await vi.advanceTimersByTimeAsync(600_000)
      expect(t.fetch).toHaveBeenCalledTimes(1)
    },
  )
  it('stops listening and sending once closed', async () => {
    const t = setup()
    await t.subscribe()
    t.push.close()
    expect(t.listeners.size).toBe(0)
    t.publish(event())
    await settle()
    expect(t.fetch).not.toHaveBeenCalled()
  })
  it('runs without Web Push when its key cannot be loaded', async () => {
    const log = vi.fn()
    const options = { identityDirectory: join(dir, 'missing'), uid: process.getuid?.(), log }
    expect(await startHostWebPush(options as unknown as WebPushOptions)).toBeUndefined()
    expect(log).toHaveBeenCalledWith('push.unavailable', {})
  })
})
