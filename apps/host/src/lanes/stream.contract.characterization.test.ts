import { describe, expect, it, vi } from 'vitest'
import type { LaneEvent } from '@phosphor/shared/host-protocol'
import { createLaneStreams, createLanesTopic } from './stream'

const epoch = '0123456789abcdef'
const event: LaneEvent = { kind: 'dialog-resolved', dialogId: 'é' }
const snapshot = () => null

describe('stream public contract characterization', () => {
  it('retains the exact count boundary and rejects stale, foreign and future lane cursors', () => {
    const streams = createLaneStreams({ epoch, snapshot, limits: { replayEvents: 2 } })
    expect(streams.replay('a', { epoch, seq: 0 })).toEqual([])
    streams.publish('a', event)
    streams.publish('a', event)
    expect(streams.replay('a', { epoch, seq: 0 })?.map((f) => f.cursor.seq)).toEqual([1, 2])
    streams.publish('a', event)
    expect(streams.replay('a', { epoch, seq: 0 })).toBeNull()
    expect(streams.replay('a', { epoch, seq: 1 })?.map((f) => f.cursor.seq)).toEqual([2, 3])
    expect(streams.replay('a', { epoch, seq: 3 })).toEqual([])
    expect(streams.replay('a', { epoch, seq: 4 })).toBeNull()
    expect(streams.replay('a', { epoch: '1111111111111111', seq: 2 })).toBeNull()
  })

  it('retains exactly the UTF-8 byte boundary, not the JSON string length', () => {
    const reference = createLaneStreams({ epoch, snapshot })
    reference.publish('a', event)
    const json = JSON.stringify(reference.replay('a', { epoch, seq: 0 })?.[0])
    const bytes = Buffer.byteLength(json)
    expect(bytes).toBe(json.length + 1)
    const exact = createLaneStreams({ epoch, snapshot, limits: { replayBytes: bytes } })
    exact.publish('a', event)
    expect(exact.replay('a', { epoch, seq: 0 })).toHaveLength(1)
    const smaller = createLaneStreams({ epoch, snapshot, limits: { replayBytes: bytes - 1 } })
    smaller.publish('a', event)
    expect(smaller.cursor('a')).toEqual({ epoch, seq: 1 })
    expect(smaller.replay('a', { epoch, seq: 0 })).toBeNull()
    expect(smaller.replay('a', { epoch, seq: 1 })).toEqual([])
  })

  it('cuts listener membership at each in-flight lane event', () => {
    const streams = createLaneStreams({ epoch, snapshot })
    const late = vi.fn()
    const removed = vi.fn()
    streams.listen('a', (frame) => {
      if (frame?.cursor.seq !== 1) return
      streams.listen('a', late)
      drop()
      streams.publish('a', event)
    })
    const drop = streams.listen('a', removed)
    streams.publish('a', event)
    expect(removed).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cursor: { epoch, seq: 2 } }),
    )
  })

  it('cuts listener membership at each in-flight topic event', () => {
    const topic = createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) })
    const late = vi.fn()
    const removed = vi.fn()
    topic.listen((frame) => {
      if (frame?.cursor.seq !== 1) return
      topic.listen(late)
      drop()
      topic.routinesChanged()
    })
    const drop = topic.listen(removed)
    topic.delta([])
    expect(removed).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledExactlyOnceWith({
      type: 'routines-changed',
      cursor: { epoch, seq: 2 },
    })
  })

  it('coalesces queue overflow into a next-macrotask reset and orders later events', async () => {
    const log = vi.fn(() => {
      throw new Error('logger failure')
    })
    const streams = createLaneStreams({ epoch, snapshot, limits: { replayEvents: 2 }, log })
    const seen: (number | null)[] = []
    streams.listen('a', (frame) => {
      if (frame?.cursor.seq === 1) {
        streams.publish('a', event)
        streams.publish('a', event)
        streams.publish('a', event)
      }
      if (frame === null) streams.publish('a', event)
    })
    streams.listen('a', (frame) => seen.push(frame?.cursor.seq ?? null))
    streams.publish('a', event)
    streams.reset('a')
    streams.publish('a', event)
    expect(seen).toEqual([1])
    expect(log).toHaveBeenCalledExactlyOnceWith('lane.stream_reentrant_overflow', { laneId: 'a' })
    expect(streams.cursor('a').seq).toBe(5)
    expect(streams.replay('a', { epoch, seq: 3 })?.map((f) => f.cursor.seq)).toEqual([4, 5])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(seen).toEqual([1, null, 6])
    streams.publish('a', event)
    expect(seen).toEqual([1, null, 6, 7])
  })

  it('bounds reentrant topic draining and resets without advancing the shared cursor', async () => {
    const log = vi.fn()
    const topic = createLanesTopic({
      epoch,
      limits: { replayEvents: 2 },
      list: () => ({ lanes: [], repositories: [] }),
      log,
    })
    const seen: (number | null)[] = []
    topic.listen((frame) => {
      if (frame && frame.cursor.seq < 4) topic.routinesChanged()
    })
    topic.listen((frame) => seen.push(frame?.cursor.seq ?? null))
    topic.delta([])
    expect(seen).toEqual([1, 2])
    expect(topic.cursor()).toEqual({ epoch, seq: 3 })
    expect(log).toHaveBeenCalledExactlyOnceWith('lane.stream_reentrant_overflow', {
      topic: 'lanes',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(seen).toEqual([1, 2, null])
    topic.routinesChanged()
    expect(seen).toEqual([1, 2, null, 4])
  })
})
