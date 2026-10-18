import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHostFrame, type HostFrame, type LaneSummary } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { createLaneStreams, createLanesTopic, type StreamLimits } from './stream'
import { createSubscriptions } from './subscriptions'

const epoch = '0123456789abcdef'
const laneId = '12345678-1234-4234-8234-123456789012'
const other = '12345678-1234-4234-8234-123456789013'
const summary: LaneSummary = {
  laneId,
  repositoryId: epoch,
  cwd: '/repo',
  title: null,
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
function setup(limits: Partial<StreamLimits> = {}) {
  const pair = createLoopbackPair()
  const received: HostFrame[] = []
  pair.client.onMessage((text) => {
    const parsed = parseHostFrame(text)
    if (!parsed.ok) throw new Error('invalid host frame')
    received.push(parsed.value)
  })
  let large = false
  const streamLog = vi.fn()
  const streams = createLaneStreams({
    epoch,
    limits,
    log: streamLog,
    snapshot(id) {
      if (id !== laneId && id !== other) return null
      if (large && id === laneId) return { ok: false, reason: 'too-large' }
      return {
        ok: true,
        snapshot: {
          cursor: streams.cursor(id),
          summary: { ...summary, laneId: id },
          state: null,
          messages: [],
          pending: [],
          dialogs: [],
          ui: [],
        },
      }
    },
  })
  const topic = createLanesTopic({
    epoch,
    limits,
    list: () => ({ lanes: [summary], repositories: [] }),
    log: streamLog,
  })
  const log = vi.fn()
  const subscriptions = createSubscriptions(pair.server, streams, topic, limits, log)
  const subscribe = (id = 's', after?: { epoch: string; seq: number }, lane = laneId) =>
    subscriptions.handle({ type: 'subscribe', topic: 'lane', id, laneId: lane, after })
  const publish = (id = laneId, dialogId = 'dialog') =>
    streams.publish(id, { kind: 'dialog-resolved', dialogId })
  return {
    pair,
    streams,
    topic,
    subscriptions,
    log,
    streamLog,
    received,
    subscribe,
    publish,
    large: () => {
      large = true
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('subscription contract characterization', () => {
  it('ends only the oversized lane and replaces an oversized event with a reset', async () => {
    const s = setup({ outboundFrameBytes: 1000 })
    s.subscribe('one')
    s.subscribe('two', undefined, other)
    await tick()
    s.publish(laneId, 'x'.repeat(1000))
    await tick()
    expect(s.received.at(-1)).toMatchObject({
      type: 'snapshot',
      id: 'one',
      reset: true,
      snapshot: { cursor: { seq: 1 } },
    })
    s.large()
    s.publish(laneId, 'x'.repeat(1000))
    s.publish(other)
    await tick()
    expect(s.received.slice(-2)).toMatchObject([
      { type: 'subscribe-failed', id: 'one', code: 'too-large' },
      { type: 'event', id: 'two' },
    ])
    expect(s.subscriptions.size()).toBe(1)
    expect(s.pair.server.isOpen()).toBe(true)
    s.subscriptions.close()
  })
  it('accepts the cap, rejects one past, duplicate ids and unknown lanes; unsubscribe preserves others', async () => {
    const s = setup({ subscriptionsPerConnection: 2 })
    s.subscribe('one')
    s.subscribe('two')
    s.subscribe('one')
    s.subscribe('three')
    s.subscriptions.handle({ type: 'unsubscribe', id: 'two' })
    s.subscribe('unknown', undefined, '12345678-1234-4234-8234-123456789014')
    await tick()
    expect(s.received.filter((f) => f.type === 'subscribe-failed')).toEqual([
      { type: 'subscribe-failed', id: 'one', code: 'bad-request' },
      { type: 'subscribe-failed', id: 'three', code: 'too-many' },
      { type: 'subscribe-failed', id: 'unknown', code: 'unknown-lane' },
    ])
    s.publish()
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'event', id: 'one' })
    expect(s.subscriptions.size()).toBe(1)
    s.subscriptions.close()
  })
  it('a stale lanes reset preserves buffered notifications after the last delivered cursor', async () => {
    vi.useFakeTimers()
    const s = setup({ sendQueueBytes: 1500 })
    s.subscriptions.handle({ type: 'subscribe', id: 'list', topic: 'lanes' })
    await tick()
    s.pair.pause()
    s.topic.delta([summary])
    s.topic.delta([summary])
    s.topic.delta([summary])
    const event = {
      id: `${laneId}:1`,
      laneId,
      kind: 'finished' as const,
      attention: 1,
      at: summary.createdAt,
      title: null,
    }
    s.topic.attention(event)
    s.topic.attention({ ...event, attention: 2, id: `${laneId}:2` })
    s.pair.resume()
    await tick()
    const count = s.received.length
    s.topic.delta([summary])
    await tick()
    expect(s.received).toHaveLength(count)
    vi.advanceTimersByTime(25)
    await tick()
    expect(s.received.slice(count).map((f) => f.type)).toEqual(['lanes', 'attention', 'attention'])
    expect(s.received.slice(count)).toMatchObject([
      { cursor: { seq: 6 } },
      { cursor: { seq: 4 } },
      { cursor: { seq: 5 } },
    ])
    s.topic.delta([summary])
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'lanes-delta', cursor: { seq: 7 } })
    s.subscriptions.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['incremental', 'reset', 'replay', 'failure'] as const)(
    'closes the transport and manager when %s send throws',
    async (path) => {
      const s = setup()
      if (path === 'incremental' || path === 'reset') s.subscribe()
      if (path === 'replay') s.publish()
      await tick()
      const send = vi.spyOn(s.pair.server, 'send').mockImplementation(() => {
        throw new Error('private')
      })
      // Deliberately stays open and does not emit onClose; manager cleanup is independent.
      const close = vi.spyOn(s.pair.server, 'close').mockImplementation(() => {})
      if (path === 'incremental') s.publish()
      else if (path === 'reset') s.streams.reset(laneId)
      else if (path === 'replay') s.subscribe('replay', { epoch, seq: 0 })
      else s.subscribe('unknown', undefined, '12345678-1234-4234-8234-123456789014')
      expect(close).toHaveBeenCalledExactlyOnceWith(4429, 'Send failed')
      expect(s.pair.server.isOpen()).toBe(true)
      expect(s.subscriptions.size()).toBe(0)
      const writes = send.mock.calls.length
      s.subscribe('ignored')
      s.publish()
      expect(send).toHaveBeenCalledTimes(writes)
      s.subscriptions.close()
    },
  )
})
it('continues attention recovery after the first notification without resending it or the list', async () => {
  vi.useFakeTimers()
  const reference = setup()
  const events = [1, 2].map((attention) => ({
    id: `${laneId}:${attention}`,
    laneId,
    kind: 'finished' as const,
    attention,
    at: summary.createdAt,
    title: null,
  }))
  for (const event of events) reference.topic.attention(event)
  const first = reference.topic.replay({ epoch, seq: 0 })[0]
  if (!first) throw new Error('missing attention')
  const cap =
    Buffer.byteLength(JSON.stringify({ ...reference.topic.snapshot(), id: 'list' })) +
    Buffer.byteLength(JSON.stringify({ ...first, id: 'list' }))
  reference.subscriptions.close()
  const s = setup({ sendQueueBytes: cap })
  for (const event of events) s.topic.attention(event)
  s.subscriptions.handle({
    type: 'subscribe',
    topic: 'lanes',
    id: 'list',
    after: { epoch, seq: 0 },
  })
  expect(s.pair.server.bufferedBytes()).toBe(cap)
  await tick()
  expect(s.received).toMatchObject([
    { type: 'lanes', cursor: { seq: 2 } },
    { type: 'attention', event: { attention: 1 } },
  ])
  expect(s.received).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(25)
  await tick()
  expect(s.received.map((frame) => frame.type)).toEqual(['lanes', 'attention', 'attention'])
  expect(
    s.received.filter((frame) => frame.type === 'attention').map((frame) => frame.event),
  ).toEqual(events)
  expect(vi.getTimerCount()).toBe(0)
  s.topic.delta([])
  await tick()
  expect(s.received.at(-1)).toMatchObject({ type: 'lanes-delta', cursor: { seq: 3 } })
  s.subscriptions.close()
})
