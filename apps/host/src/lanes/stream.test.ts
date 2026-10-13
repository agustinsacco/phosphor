import { describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneEvent } from '@phosphor/shared/host-protocol'
import { createLaneStreams, createLanesTopic, streamLimits } from './stream'

const epoch = '0123456789abcdef'
const event: LaneEvent = { kind: 'dialog-resolved', dialogId: 'a' }
function setup(limits = {}) {
  return createLaneStreams({ epoch, limits, snapshot: () => null })
}
describe('lane streams', () => {
  it('starts at zero, publishes synchronously, replays exactly a gap and isolates viewers', () => {
    const s = setup()
    expect(s.cursor('a')).toEqual({ epoch, seq: 0 })
    const seen: number[] = []
    s.listen('a', () => {
      throw new Error('private')
    })
    const drop = s.listen('a', (f) => {
      if (f) seen.push(f.cursor.seq)
    })
    for (let n = 0; n < 4; n++) s.publish('a', event)
    expect(seen).toEqual([1, 2, 3, 4])
    expect(s.replay('a', { epoch, seq: 2 })?.map((e) => e.cursor.seq)).toEqual([3, 4])
    drop()
    s.publish('a', event)
    expect(seen).toHaveLength(4)
    expect(s.replay('a', { epoch, seq: 5 })).toEqual([])
    expect(s.replay('a', { epoch, seq: 6 })).toBeNull()
    expect(s.replay('a', { epoch: '1111111111111111', seq: 2 })).toBeNull()
  })
  it('bounds replay count at the boundary, evicts one past, resets and forgets', () => {
    const s = setup({ replayEvents: 2 })
    s.publish('a', event)
    s.publish('a', event)
    expect(s.replay('a', { epoch, seq: 0 })).toHaveLength(2)
    s.publish('a', event)
    expect(s.replay('a', { epoch, seq: 0 })).toBeNull()
    expect(s.replay('a', { epoch, seq: 1 })?.map((e) => e.cursor.seq)).toEqual([2, 3])
    const listener = vi.fn()
    s.listen('a', listener)
    s.reset('a')
    expect(listener).toHaveBeenLastCalledWith(null)
    s.forget('a')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(s.cursor('a').seq).toBe(0)
  })
  it('bounds replay UTF-8 bytes at exactly the frame size and one byte past', () => {
    const reference = setup()
    reference.publish('a', event)
    const frame = reference.replay('a', { epoch, seq: 0 })?.[0]
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    const exact = setup({ replayBytes: bytes })
    exact.publish('a', event)
    expect(exact.replay('a', { epoch, seq: 0 })).toHaveLength(1)
    const smaller = setup({ replayBytes: bytes - 1 })
    smaller.publish('a', event)
    expect(smaller.replay('a', { epoch, seq: 0 })).toBeNull()
    const unicode = setup({ replayBytes: bytes })
    unicode.publish('a', { kind: 'dialog-resolved', dialogId: 'é' })
    expect(unicode.replay('a', { epoch, seq: 0 })).toBeNull()
  })
  it('caps lanes, including listener-only lanes, and reuses a forgotten slot', () => {
    const s = setup({ lanesPerHost: 1 })
    s.listen('a', () => {})
    expect(() => s.publish('b', event)).toThrow('capacity')
    s.forget('a')
    expect(s.publish('b', event).seq).toBe(1)
  })
  it('validates lowered limits and the epoch', () => {
    expect(streamLimits(HOST_LIMITS).replayEvents).toBe(HOST_LIMITS.replayEvents)
    for (const key of [
      'replayEvents',
      'replayBytes',
      'lanesPerHost',
      'attentionReplay',
      'outboundFrameBytes',
      'sendQueueBytes',
      'subscriptionsPerConnection',
    ] as const) {
      for (const value of [0, -1, 1.1, NaN, HOST_LIMITS[key] + 1])
        expect(() => streamLimits({ [key]: value })).toThrow('limit')
    }
    expect(() => createLaneStreams({ epoch: 'bad', snapshot: () => null })).toThrow('epoch')
    expect(() =>
      createLanesTopic({ epoch: 'bad', list: () => ({ lanes: [], repositories: [] }) }),
    ).toThrow('epoch')
  })
})
describe('stream dispatch ordering', () => {
  it('trampolines reentrant events, isolates throwing viewers and resets dispatch state', () => {
    const streams = setup()
    const early: number[] = [],
      late: number[] = []
    streams.listen('a', () => {
      throw new Error('viewer failed')
    })
    streams.listen('a', (frame) => {
      if (!frame) return
      early.push(frame.cursor.seq)
      if (frame.cursor.seq === 1) expect(streams.publish('a', event).seq).toBe(2)
    })
    streams.listen('a', (frame) => {
      if (frame) late.push(frame.cursor.seq)
    })
    expect(streams.publish('a', event).seq).toBe(1)
    expect(streams.cursor('a').seq).toBe(2)
    expect(early).toEqual([1, 2])
    expect(late).toEqual([1, 2])
    streams.publish('a', event)
    expect(late).toEqual([1, 2, 3])
  })
  it('trampolines the shared lanes topic too', () => {
    const topic = createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) })
    const early: number[] = [],
      late: number[] = []
    topic.listen(() => {
      throw new Error('viewer failed')
    })
    topic.listen((frame) => {
      if (!frame) return
      early.push(frame.cursor.seq)
      if (frame.cursor.seq === 1) topic.delta([])
    })
    topic.listen((frame) => {
      if (frame) late.push(frame.cursor.seq)
    })
    topic.attention({
      id: '12345678-1234-4234-8234-123456789012:1',
      laneId: '12345678-1234-4234-8234-123456789012',
      kind: 'finished',
      attention: 1,
      at: '2026-10-13T00:00:00.000Z',
      title: null,
    })
    expect(early).toEqual([1, 2])
    expect(late).toEqual([1, 2])
    topic.delta([])
    expect(late).toEqual([1, 2, 3])
  })
})
describe('stream listener cuts', () => {
  it('new subscribers skip the current frame and unsubscribed viewers receive nothing', () => {
    const streams = setup()
    const late = vi.fn(),
      removed = vi.fn()
    streams.listen('a', () => {
      streams.listen('a', late)
      drop()
    })
    const drop = streams.listen('a', removed)
    streams.publish('a', event)
    expect(late).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
    streams.publish('a', event)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late.mock.calls[0]?.[0]).toMatchObject({ cursor: { seq: 2 } })
  })
})
describe('lanes topic', () => {
  it('shares a contiguous counter, bounds attention replay, never replays across epochs or future cursors', () => {
    const topic = createLanesTopic({
      epoch,
      limits: { attentionReplay: 2 },
      list: () => ({ lanes: [], repositories: [] }),
    })
    const seqs: number[] = []
    topic.listen((frame) => {
      if (frame) seqs.push(frame.cursor.seq)
    })
    const attention = {
      id: '12345678-1234-4234-8234-123456789012:1',
      laneId: '12345678-1234-4234-8234-123456789012',
      kind: 'finished' as const,
      attention: 1,
      at: '2026-10-13T00:00:00.000Z',
      title: null,
    }
    topic.attention(attention)
    topic.delta([])
    topic.attention(attention)
    expect(topic.replay({ epoch, seq: 0 }).map((f) => f.cursor.seq)).toEqual([1, 3])
    topic.attention(attention)
    expect(topic.replay({ epoch, seq: 0 }).map((f) => f.cursor.seq)).toEqual([3, 4])
    expect(topic.replay({ epoch, seq: 3 }).map((f) => f.cursor.seq)).toEqual([4])
    expect(topic.replay({ epoch: '1111111111111111', seq: 0 })).toEqual([])
    expect(topic.replay({ epoch, seq: 5 })).toEqual([])
    expect(topic.replay()).toEqual([])
    expect(topic.snapshot().cursor.seq).toBe(4)
    expect(seqs).toEqual([1, 2, 3, 4])
  })
  it('rejects malformed attention and deltas before retaining or numbering them', () => {
    const invalid = vi.fn()
    const topic = createLanesTopic({
      epoch,
      invalid,
      list: () => ({ lanes: [], repositories: [] }),
    })
    const listener = vi.fn()
    topic.listen(listener)
    topic.attention({
      id: 'bad',
      laneId: '12345678-1234-4234-8234-123456789012',
      kind: 'finished',
      attention: 1,
      at: '2026-10-13T00:00:00.000Z',
      title: 'hidden-value',
    })
    topic.delta([], ['invalid'])
    expect(listener).not.toHaveBeenCalled()
    expect(topic.cursor().seq).toBe(0)
    expect(topic.replay({ epoch, seq: 0 })).toEqual([])
    expect(invalid).toHaveBeenCalledExactlyOnceWith('12345678-1234-4234-8234-123456789012')
    expect(JSON.stringify(invalid.mock.calls)).not.toContain('hidden-value')
  })
})
