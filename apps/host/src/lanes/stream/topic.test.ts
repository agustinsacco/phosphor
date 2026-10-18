import { describe, expect, it, vi } from 'vitest'
import type { AttentionEvent, LaneSummary } from '@phosphor/shared/host-protocol'
import { streamLimits } from '../stream'
import {
  createLanesTopicState,
  listenTopic,
  publishAttention,
  publishDelta,
  replayAttention,
  repositoriesChanged,
  routinesChanged,
  topicCursor,
  topicSnapshot,
} from './topic'

const epoch = '0123456789abcdef'
const laneId = '12345678-1234-4234-8234-123456789012'
const event: AttentionEvent = {
  id: `${laneId}:1`,
  laneId,
  kind: 'finished',
  attention: 1,
  at: '2026-10-13T00:00:00.000Z',
  title: null,
}
const summary: LaneSummary = {
  laneId,
  repositoryId: '0123456789abcdef',
  cwd: '/workspace',
  title: null,
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: event.at,
  updatedAt: event.at,
  attention: 1,
  read: 0,
  control: { fence: 1, controller: null },
}

function setup(limits = {}) {
  return createLanesTopicState({
    epoch,
    limits: streamLimits(limits),
    list: () => ({ lanes: [summary], repositories: [] }),
  })
}

describe('lanes topic state', () => {
  it('shares one counter for attention, deltas and routines but not repository resets', () => {
    const state = setup()
    const seen: (number | null)[] = []
    listenTopic(state, (frame) => seen.push(frame?.cursor.seq ?? null))
    expect(topicCursor(state)).toEqual({ epoch, seq: 0 })
    publishAttention(state, event)
    publishDelta(state, [summary])
    routinesChanged(state)
    repositoriesChanged(state)
    expect(seen).toEqual([1, 2, 3, null])
    expect(topicSnapshot(state)).toEqual({
      type: 'lanes',
      cursor: { epoch, seq: 3 },
      lanes: [summary],
      repositories: [],
    })
    expect(replayAttention(state, { epoch, seq: 0 }).map((f) => f.cursor.seq)).toEqual([1])
  })

  it('bounds attention-only replay and filters absent, foreign and future cursors', () => {
    const state = setup({ attentionReplay: 2 })
    publishAttention(state, event)
    routinesChanged(state)
    publishAttention(state, event)
    publishDelta(state, [], [laneId])
    expect(replayAttention(state, { epoch, seq: 0 }).map((f) => f.cursor.seq)).toEqual([1, 3])
    publishAttention(state, event)
    expect(replayAttention(state, { epoch, seq: 0 }).map((f) => f.cursor.seq)).toEqual([3, 5])
    expect(replayAttention(state, { epoch, seq: 3 }).map((f) => f.cursor.seq)).toEqual([5])
    expect(replayAttention(state, { epoch, seq: 6 })).toEqual([])
    expect(replayAttention(state, { epoch: '1111111111111111', seq: 0 })).toEqual([])
    expect(replayAttention(state)).toEqual([])
  })

  it('rejects invalid frames before numbering and isolates invalidation callback failures', () => {
    const state = setup()
    const invalid = vi.fn(() => {
      throw new Error('invalidation failed')
    })
    state.invalid = invalid
    const listener = vi.fn()
    listenTopic(state, listener)
    publishAttention(state, { ...event, id: 'bad', title: 'private-title' })
    publishDelta(state, [
      { ...summary, repositoryId: 'bad' },
      { ...summary, cwd: '' },
    ])
    publishDelta(state, [], ['invalid'])
    expect(listener).not.toHaveBeenCalled()
    expect(topicCursor(state).seq).toBe(0)
    expect(replayAttention(state, { epoch, seq: 0 })).toEqual([])
    expect(invalid.mock.calls).toEqual([[laneId], [laneId], [laneId]])
    expect(JSON.stringify(invalid.mock.calls)).not.toContain('private-title')
    publishDelta(state, [summary])
    expect(topicCursor(state).seq).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fails closed when serialization throws without retaining the frame', () => {
    const state = setup()
    const invalid = vi.fn()
    state.invalid = invalid
    publishAttention(state, {
      ...event,
      get title(): string {
        throw new Error('serialization failed')
      },
    })
    expect(topicCursor(state).seq).toBe(0)
    expect(state.attention).toEqual([])
    expect(invalid).toHaveBeenCalledExactlyOnceWith(laneId)
  })

  it('preserves exhaustion semantics for validated frames and routine invalidations', () => {
    const state = setup()
    const invalid = vi.fn()
    state.invalid = invalid
    const listener = vi.fn()
    listenTopic(state, listener)
    state.seq = Number.MAX_SAFE_INTEGER - 1
    publishAttention(state, event)
    expect(topicCursor(state).seq).toBe(Number.MAX_SAFE_INTEGER)
    publishAttention(state, event)
    publishDelta(state, [summary])
    expect(invalid.mock.calls).toEqual([[laneId], [laneId]])
    expect(() => routinesChanged(state)).toThrow('stream sequence exhausted')
    expect(topicCursor(state).seq).toBe(Number.MAX_SAFE_INTEGER)
    expect(state.attention).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes without changing the shared cursor or retained attention', () => {
    const state = setup()
    const listener = vi.fn()
    const drop = listenTopic(state, listener)
    publishAttention(state, event)
    drop()
    routinesChanged(state)
    publishAttention(state, event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(topicCursor(state).seq).toBe(3)
    expect(replayAttention(state, { epoch, seq: 0 }).map((f) => f.cursor.seq)).toEqual([1, 3])
  })
})
