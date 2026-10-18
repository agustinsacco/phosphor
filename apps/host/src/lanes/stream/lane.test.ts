import { describe, expect, it, vi } from 'vitest'
import type { LaneEvent } from '@phosphor/shared/host-protocol'
import { streamLimits } from '../stream'
import {
  createLaneStreamState,
  forgetLane,
  laneCursor,
  listenLane,
  publishLane,
  replayLane,
  resetLane,
} from './lane'

const epoch = '0123456789abcdef'
const event: LaneEvent = { kind: 'dialog-resolved', dialogId: 'é' }

function setup(limits = {}) {
  return createLaneStreamState({ epoch, limits: streamLimits(limits) })
}

describe('lane replay state', () => {
  it('retains the count boundary and tracks bytes when evicting', () => {
    const state = setup({ replayEvents: 2 })
    publishLane(state, 'a', event)
    publishLane(state, 'a', event)
    const value = state.lanes.get('a')
    expect(replayLane(state, 'a', { epoch, seq: 0 })).toHaveLength(2)
    publishLane(state, 'a', event)
    expect(replayLane(state, 'a', { epoch, seq: 0 })).toBeNull()
    expect(replayLane(state, 'a', { epoch, seq: 1 })?.map((f) => f.cursor.seq)).toEqual([2, 3])
    expect(value?.bytes).toBe(value?.replay.reduce((sum, entry) => sum + entry.bytes, 0))
  })

  it('enforces cumulative UTF-8 bytes and empties replay for an oversized event', () => {
    const reference = setup()
    publishLane(reference, 'a', event)
    const frame = replayLane(reference, 'a', { epoch, seq: 0 })?.[0]
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    const state = setup({ replayBytes: bytes * 2 })
    publishLane(state, 'a', event)
    publishLane(state, 'a', event)
    expect(replayLane(state, 'a', { epoch, seq: 0 })).toHaveLength(2)
    publishLane(state, 'a', event)
    expect(replayLane(state, 'a', { epoch, seq: 1 })).toHaveLength(2)
    publishLane(state, 'a', { kind: 'dialog-resolved', dialogId: 'é'.repeat(bytes) })
    expect(state.lanes.get('a')?.bytes).toBe(0)
    expect(replayLane(state, 'a', { epoch, seq: 3 })).toBeNull()
    expect(replayLane(state, 'a', { epoch, seq: 4 })).toEqual([])
  })

  it('refuses sequence exhaustion before changing replay or notifying listeners', () => {
    const state = setup()
    const listener = vi.fn()
    listenLane(state, 'a', listener)
    const value = state.lanes.get('a')
    if (!value) throw new Error('missing lane state')
    value.seq = Number.MAX_SAFE_INTEGER - 1
    expect(publishLane(state, 'a', event).seq).toBe(Number.MAX_SAFE_INTEGER)
    const retained = [...value.replay]
    expect(() => publishLane(state, 'a', event)).toThrow('stream sequence exhausted')
    expect(value.seq).toBe(Number.MAX_SAFE_INTEGER)
    expect(value.replay).toEqual(retained)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('counts listener-only lanes, but not cursor, replay or reset reads, against capacity', () => {
    const state = setup({ lanesPerHost: 1 })
    expect(laneCursor(state, 'missing')).toEqual({ epoch, seq: 0 })
    expect(replayLane(state, 'missing', { epoch, seq: 0 })).toEqual([])
    resetLane(state, 'missing')
    forgetLane(state, 'missing')
    expect(state.lanes.size).toBe(0)
    const drop = listenLane(state, 'a', vi.fn())
    drop()
    expect(() => listenLane(state, 'b', vi.fn())).toThrow('stream lane capacity reached')
    expect(() => publishLane(state, 'b', event)).toThrow('stream lane capacity reached')
    forgetLane(state, 'a')
    expect(publishLane(state, 'b', event).seq).toBe(1)
  })

  it('resets without losing replay and forgets before notifying old listeners', () => {
    const state = setup()
    const seen: (number | null)[] = []
    listenLane(state, 'a', (frame) => seen.push(frame?.cursor.seq ?? null))
    publishLane(state, 'a', event)
    resetLane(state, 'a')
    expect(laneCursor(state, 'a').seq).toBe(1)
    expect(replayLane(state, 'a', { epoch, seq: 0 })).toHaveLength(1)
    const cursorsAtReset: number[] = []
    listenLane(state, 'a', (frame) => {
      if (frame === null) cursorsAtReset.push(laneCursor(state, 'a').seq)
    })
    forgetLane(state, 'a')
    expect(cursorsAtReset).toEqual([0])
    expect(replayLane(state, 'a', { epoch, seq: 0 })).toEqual([])
    publishLane(state, 'a', event)
    expect(seen).toEqual([1, null, null])
  })
})
