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
describe('subscriptions', () => {
  it('replays the exact gap, resets evicted, different-epoch and future cursors, then continues', async () => {
    const s = setup({ replayEvents: 2 })
    s.publish()
    s.publish()
    s.publish()
    s.subscribe('gap', { epoch, seq: 1 })
    s.subscribe('old', { epoch, seq: 0 })
    s.subscribe('epoch', { epoch: '1111111111111111', seq: 3 })
    s.subscribe('future', { epoch, seq: 4 })
    await tick()
    expect(
      s.received
        .filter((f) => f.type === 'event' && f.id === 'gap')
        .map((f) => f.type === 'event' && f.cursor.seq),
    ).toEqual([2, 3])
    for (const id of ['old', 'epoch', 'future']) {
      expect(s.received.find((f) => f.type === 'snapshot' && f.id === id)).toMatchObject({
        reset: true,
        snapshot: { cursor: { epoch, seq: 3 } },
      })
    }
    s.publish()
    await tick()
    expect(s.received.filter((f) => f.type === 'event' && f.cursor.seq === 4)).toHaveLength(4)
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
  it('checks the actual snapshot envelope byte boundary and lanes frame size', async () => {
    const reference = setup()
    reference.subscribe()
    await tick()
    const bytes = Buffer.byteLength(JSON.stringify(reference.received[0]))
    reference.subscriptions.close()
    const exact = setup({ outboundFrameBytes: bytes })
    exact.subscribe()
    await tick()
    expect(exact.received[0]?.type).toBe('snapshot')
    exact.subscriptions.close()
    const smaller = setup({ outboundFrameBytes: bytes - 1 })
    smaller.subscribe()
    await tick()
    expect(smaller.received[0]).toMatchObject({ type: 'subscribe-failed', code: 'too-large' })
    smaller.subscriptions.close()
    const lanes = setup({ outboundFrameBytes: 100 })
    lanes.subscriptions.handle({ type: 'subscribe', id: 'list', topic: 'lanes' })
    await tick()
    expect(lanes.received[0]).toMatchObject({ type: 'subscribe-failed', code: 'too-large' })
    expect(lanes.pair.server.isOpen()).toBe(true)
    lanes.subscriptions.close()
  })
  it('bounds a paused viewer, recovers below half with one reset and contiguous events; close clears timers', async () => {
    vi.useFakeTimers()
    const s = setup({ sendQueueBytes: 1000 })
    s.subscribe()
    await tick()
    s.pair.pause()
    for (let n = 0; n < 100; n++) s.publish()
    expect(s.pair.server.bufferedBytes()).toBeLessThanOrEqual(1000)
    expect(s.subscriptions.queuedBytes()).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(100)
    expect(s.received.filter((f) => f.type === 'snapshot')).toHaveLength(1)
    s.pair.resume()
    await tick()
    const drained = s.received.length
    s.publish()
    await tick()
    expect(s.received).toHaveLength(drained)
    vi.advanceTimersByTime(25)
    await tick()
    expect(s.received.filter((f) => f.type === 'snapshot')).toHaveLength(2)
    expect(s.received.at(-1)).toMatchObject({
      type: 'snapshot',
      reset: true,
      snapshot: { cursor: { seq: 101 } },
    })
    expect(vi.getTimerCount()).toBe(0)
    s.publish()
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'event', cursor: { seq: 102 } })
    s.pair.pause()
    for (let n = 0; n < 20; n++) s.publish()
    s.pair.sever()
    await tick()
    expect(s.subscriptions.size()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    s.subscribe()
    expect(s.subscriptions.size()).toBe(0)
  })
  it('lanes list precedes attention replay, then live frames continue at list cursor + 1', async () => {
    const s = setup({ attentionReplay: 2 })
    const event = {
      id: `${laneId}:1`,
      laneId,
      kind: 'finished' as const,
      attention: 1,
      at: summary.createdAt,
      title: null,
    }
    s.topic.attention(event)
    s.topic.delta([summary])
    s.topic.attention({ ...event, attention: 2, id: `${laneId}:2` })
    s.subscriptions.handle({
      type: 'subscribe',
      id: 'list',
      topic: 'lanes',
      after: { epoch, seq: 0 },
    })
    await tick()
    expect(s.received.map((f) => ('cursor' in f ? [f.type, f.cursor.seq] : null))).toEqual([
      ['lanes', 3],
      ['attention', 1],
      ['attention', 3],
    ])
    s.topic.delta([summary])
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'lanes-delta', cursor: { seq: 4 } })
    s.subscriptions.close()
    for (const after of [undefined, { epoch: '1111111111111111', seq: 0 }, { epoch, seq: 100 }]) {
      const fresh = setup()
      fresh.topic.attention(event)
      fresh.subscriptions.handle({ type: 'subscribe', id: 'list', topic: 'lanes', after })
      await tick()
      expect(fresh.received.map((f) => f.type)).toEqual(['lanes'])
      fresh.subscriptions.close()
    }
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
  it('limits direct failure traffic, closes exactly once, and clears stale subscriptions', async () => {
    vi.useFakeTimers()
    const s = setup({ sendQueueBytes: 1000, subscriptionsPerConnection: 1 })
    s.subscribe()
    await tick()
    s.pair.pause()
    const writes = vi.spyOn(s.pair.server, 'send')
    const closes = vi.spyOn(s.pair.server, 'close')
    for (let n = 0; n < 10; n++) s.publish()
    expect(vi.getTimerCount()).toBe(1)
    s.log.mockImplementation(() => {
      throw new Error('logger failed')
    })
    for (let n = 0; n < 100; n++) {
      s.subscribe(n % 2 ? 's' : 'past-cap')
    }
    await tick()
    expect(closes).toHaveBeenCalledExactlyOnceWith(4429, 'Subscription queue full')
    expect(s.subscriptions.size()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const count = writes.mock.calls.length
    s.subscribe('after')
    s.publish()
    expect(writes).toHaveBeenCalledTimes(count)
    const unknown = setup({ sendQueueBytes: 200 })
    const unknownClose = vi.spyOn(unknown.pair.server, 'close')
    unknown.pair.pause()
    for (let n = 0; n < 20; n++)
      unknown.subscribe(`u${n}`, undefined, '12345678-1234-4234-8234-123456789014')
    expect(unknownClose).toHaveBeenCalledExactlyOnceWith(4429, 'Subscription queue full')
    unknown.subscriptions.close()
  })
  it('ends a never-fit frame instead of staying stale; other subscriptions continue', async () => {
    vi.useFakeTimers()
    const s = setup({ sendQueueBytes: 500 })
    s.subscribe('large')
    await tick()
    expect(s.received[0]).toMatchObject({ type: 'subscribe-failed', code: 'too-large' })
    expect(s.subscriptions.size()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    s.subscribe('small', { epoch, seq: 0 }, other)
    s.publish(other)
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'event', id: 'small' })
    s.subscriptions.close()
  })
  it('recovers strictly below half, not at half; unsubscribe drops recovery timers', async () => {
    vi.useFakeTimers()
    const s = setup({ sendQueueBytes: 2000 })
    s.subscribe()
    await tick()
    const buffered = vi.spyOn(s.pair.server, 'bufferedBytes').mockReturnValue(2000)
    s.publish()
    buffered.mockReturnValue(1000)
    vi.advanceTimersByTime(25)
    await tick()
    expect(s.received.filter((f) => f.type === 'snapshot')).toHaveLength(1)
    buffered.mockReturnValue(999)
    vi.advanceTimersByTime(25)
    await tick()
    expect(s.received.filter((f) => f.type === 'snapshot')).toHaveLength(2)
    buffered.mockReturnValue(2000)
    s.publish()
    expect(vi.getTimerCount()).toBe(1)
    s.subscriptions.handle({ type: 'unsubscribe', id: 's' })
    expect(vi.getTimerCount()).toBe(0)
    s.subscriptions.close()
  })
  it('unknown lanes never consume stream slots', async () => {
    const s = setup({ lanesPerHost: 1 })
    for (let n = 0; n < 3; n++) {
      s.subscribe(`u${n}`, undefined, '12345678-1234-4234-8234-123456789014')
      await tick()
    }
    s.subscribe()
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'snapshot', id: 's' })
    s.subscriptions.close()
  })
  it('allows exactly the connection byte cap for events and direct responses', async () => {
    const reference = setup()
    reference.subscribe('s', { epoch, seq: 0 })
    reference.publish()
    await tick()
    const bytes = Buffer.byteLength(JSON.stringify(reference.received[0]))
    reference.subscriptions.close()
    const exact = setup({ sendQueueBytes: bytes })
    exact.subscribe('s', { epoch, seq: 0 })
    exact.publish()
    await tick()
    expect(exact.received[0]?.type).toBe('event')
    exact.subscriptions.close()
    const failureBytes = Buffer.byteLength(
      JSON.stringify({ type: 'subscribe-failed', id: 'u', code: 'unknown-lane' }),
    )
    const failure = setup({ sendQueueBytes: failureBytes })
    failure.pair.pause()
    failure.subscribe('u', undefined, '12345678-1234-4234-8234-123456789014')
    expect(failure.pair.server.isOpen()).toBe(true)
    expect(failure.pair.server.bufferedBytes()).toBe(failureBytes)
    failure.subscriptions.close()
  })
  it('a closed manager never reads another snapshot or installs a listener', () => {
    const s = setup()
    s.subscriptions.close()
    const snapshot = vi.spyOn(s.streams, 'snapshot')
    const listen = vi.spyOn(s.streams, 'listen')
    s.subscribe()
    expect(snapshot).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
  })
  it('bounds a reentrant FIFO, logs once and resets without delivering queued frames', async () => {
    const s = setup({ replayEvents: 2 })
    s.subscribe()
    await tick()
    s.received.length = 0
    s.streamLog.mockImplementation(() => {
      throw new Error('logger failed')
    })
    const drop = s.streams.listen(laneId, (frame) => {
      if (frame?.cursor.seq === 1) for (let n = 0; n < 10; n++) s.publish()
    })
    s.publish()
    await tick()
    expect(s.received.map((f) => f.type)).toEqual(['event'])
    await new Promise<void>((resolve) => setImmediate(resolve))
    await tick()
    expect(s.received.map((f) => f.type)).toEqual(['event', 'snapshot'])
    expect(s.received.at(-1)).toMatchObject({ reset: true, snapshot: { cursor: { seq: 11 } } })
    expect(s.streamLog.mock.calls).toEqual([['lane.stream_reentrant_overflow', { laneId }]])
    expect(s.streams.replay(laneId, { epoch, seq: 9 })?.map((f) => f.cursor.seq)).toEqual([10, 11])
    drop()
    s.publish()
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'event', cursor: { seq: 12 } })
    s.subscriptions.close()
  })
  it('bounds ping-pong delivery, resets once, and can publish normally afterwards', async () => {
    const s = setup({ replayEvents: 2 })
    s.subscribe()
    await tick()
    s.received.length = 0
    let attempts = 0
    const drop = s.streams.listen(laneId, (frame) => {
      if (!frame) return
      // A broken drain counter fails assertions instead of hanging the test process.
      if (++attempts > 20) throw new Error('runaway test listener')
      s.publish()
    })
    s.publish()
    await tick()
    expect(attempts).toBe(2)
    expect(s.received.map((f) => f.type)).toEqual(['event', 'event'])
    await new Promise<void>((resolve) => setImmediate(resolve))
    await tick()
    expect(s.received.map((f) => f.type)).toEqual(['event', 'event', 'snapshot'])
    expect(s.received.at(-1)).toMatchObject({ reset: true, snapshot: { cursor: { seq: 3 } } })
    expect(s.streamLog.mock.calls).toEqual([['lane.stream_reentrant_overflow', { laneId }]])
    drop()
    s.publish()
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'event', cursor: { seq: 4 } })
    s.subscriptions.close()
  }, 1000)
  it('a reentrant lanes-topic overflow resets the list and logs only the topic', async () => {
    const s = setup({ replayEvents: 2 })
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'list' })
    await tick()
    s.received.length = 0
    const drop = s.topic.listen((frame) => {
      if (frame?.cursor.seq === 1) for (let n = 0; n < 10; n++) s.topic.delta([summary])
    })
    s.topic.delta([summary])
    await tick()
    expect(s.received.map((f) => f.type)).toEqual(['lanes-delta'])
    await new Promise<void>((resolve) => setImmediate(resolve))
    await tick()
    expect(s.received.map((f) => f.type)).toEqual(['lanes-delta', 'lanes'])
    expect(s.received.at(-1)).toMatchObject({ cursor: { seq: 11 } })
    expect(s.streamLog.mock.calls).toEqual([['lane.stream_reentrant_overflow', { topic: 'lanes' }]])
    drop()
    s.topic.delta([summary])
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'lanes-delta', cursor: { seq: 12 } })
    s.subscriptions.close()
  })
})

describe('subscription review guards', () => {
  it.each(['snapshot', 'replay'] as const)(
    'drops queued events covered by the %s cut',
    async (path) => {
      const s = setup()
      s.streams.listen(laneId, (frame) => {
        if (frame?.cursor.seq !== 1) return
        s.publish()
        s.subscribe('late', path === 'replay' ? { epoch, seq: 0 } : undefined)
      })
      s.publish()
      s.publish()
      await tick()
      const cursors = s.received.map((f) =>
        f.type === 'snapshot' ? f.snapshot.cursor.seq : f.type === 'event' ? f.cursor.seq : null,
      )
      expect(cursors).toEqual(path === 'replay' ? [1, 2, 3] : [2, 3])
      s.subscriptions.close()
    },
  )
  it('drops queued deltas and attention covered by the list cut', async () => {
    const s = setup()
    s.topic.listen((frame) => {
      if (frame?.cursor.seq !== 1) return
      s.topic.delta([summary])
      s.topic.attention({
        id: `${laneId}:1`,
        laneId,
        kind: 'finished',
        attention: 1,
        at: summary.createdAt,
        title: null,
      })
      s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'late' })
    })
    s.topic.delta([summary])
    s.topic.delta([summary])
    await tick()
    expect(s.received).toMatchObject([
      { type: 'lanes', cursor: { seq: 3 } },
      { type: 'lanes-delta', cursor: { seq: 4 } },
    ])
    expect(s.received).toHaveLength(2)
    s.subscriptions.close()
  })
  it('queues publication inside a deferred reset; early and late viewers converge without duplicates', async () => {
    const s = setup({ replayEvents: 2 })
    s.subscribe('early')
    const drop = s.streams.listen(laneId, (frame) => {
      if (frame?.cursor.seq === 1) for (let n = 0; n < 10; n++) s.publish()
      if (frame === null) s.publish()
    })
    s.subscribe('late')
    await tick()
    s.publish()
    await tick()
    expect(s.received.filter((f) => f.type === 'snapshot')).toHaveLength(2)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await tick()
    drop()
    s.publish()
    await tick()
    for (const [id, expected] of [
      ['early', [0, 1, 11, 12, 13]],
      ['late', [0, 1, 12, 13]],
    ] as const) {
      const cursors = s.received
        .filter((f) => 'id' in f && f.id === id)
        .map((f) =>
          f.type === 'snapshot' ? f.snapshot.cursor.seq : f.type === 'event' ? f.cursor.seq : null,
        )
      expect(cursors).toEqual(expected)
    }
    s.subscriptions.close()
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
  it('makes progress at the exact list-byte cap without repeating the list', async () => {
    vi.useFakeTimers()
    const reference = setup()
    reference.topic.attention({
      id: `${laneId}:1`,
      laneId,
      kind: 'finished',
      attention: 1,
      at: summary.createdAt,
      title: null,
    })
    const cap = Buffer.byteLength(JSON.stringify({ ...reference.topic.snapshot(), id: 'list' }))
    reference.subscriptions.close()
    const s = setup({ sendQueueBytes: cap })
    s.topic.attention({
      id: `${laneId}:1`,
      laneId,
      kind: 'finished',
      attention: 1,
      at: summary.createdAt,
      title: null,
    })
    s.subscriptions.handle({
      type: 'subscribe',
      topic: 'lanes',
      id: 'list',
      after: { epoch, seq: 0 },
    })
    await tick()
    expect(s.received.map((f) => f.type)).toEqual(['lanes'])
    expect(vi.getTimerCount()).toBe(1)
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(25)
      await tick()
    }
    expect(s.received.map((f) => f.type)).toEqual(['lanes', 'attention'])
    expect(vi.getTimerCount()).toBe(0)
    s.topic.delta([])
    await tick()
    expect(s.received.at(-1)).toMatchObject({ type: 'lanes-delta', cursor: { seq: 2 } })
    s.subscriptions.close()
  })
  it('failure logs contain only code, topic and validated trace, never client subscription ids', () => {
    const s = setup()
    const trace = 'abcdef0123456789'
    s.subscriptions.handle({
      type: 'subscribe',
      topic: 'lane',
      laneId: other.replace(/3$/, '4'),
      id: 'private-client-input',
      trace,
    })
    expect(s.log.mock.calls).toEqual([
      ['lanes.subscribe_failed', { topic: 'lane', code: 'unknown-lane', trace }],
    ])
    expect(JSON.stringify(s.log.mock.calls)).not.toContain('private-client-input')
    s.subscriptions.close()
  })
})
