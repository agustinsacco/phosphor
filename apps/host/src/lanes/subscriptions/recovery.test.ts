import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFrame, LaneSummary } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { createLaneStreams, createLanesTopic, streamLimits } from '../stream'
import { close } from './delivery'
import { reset } from './recovery'
import type { Subscription, SubscriptionState } from './state'

const epoch = '0123456789abcdef'
const laneId = '12345678-1234-4234-8234-123456789012'
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

function setup(topic: 'lane' | 'lanes' = 'lanes') {
  const pair = createLoopbackPair()
  const frames: HostFrame[] = []
  const write = vi.spyOn(pair.server, 'send').mockImplementation((text) => {
    frames.push(JSON.parse(text) as HostFrame)
  })
  const streams = createLaneStreams({
    epoch,
    snapshot(id) {
      if (id !== laneId) return null
      return {
        ok: true,
        snapshot: {
          cursor: streams.cursor(id),
          summary,
          state: null,
          messages: [],
          pending: [],
          dialogs: [],
          ui: [],
        },
      }
    },
  })
  const lanesTopic = createLanesTopic({
    epoch,
    list: () => ({ lanes: [summary], repositories: [] }),
  })
  const sub: Subscription = {
    request:
      topic === 'lane'
        ? { type: 'subscribe', topic, id: 's', laneId, after: { epoch, seq: 0 } }
        : { type: 'subscribe', topic, id: 's', after: { epoch, seq: 0 } },
    stale: true,
    cursor: { epoch, seq: 0 },
    drop: vi.fn(),
  }
  const state: SubscriptionState = {
    socket: pair.server,
    streams,
    lanesTopic,
    limits: streamLimits(),
    log: vi.fn(),
    subscriptions: new Map([['s', sub]]),
    closed: false,
  }
  const attention = (n: number) =>
    lanesTopic.attention({
      id: `${laneId}:${n}`,
      laneId,
      kind: 'finished',
      attention: n,
      at: summary.createdAt,
      title: null,
    })
  return { pair, frames, write, streams, lanesTopic, sub, state, attention }
}
afterEach(() => vi.useRealTimers())

describe('subscription recovery', () => {
  it('keeps historical replay progress separate from a newer live cut', () => {
    vi.useFakeTimers()
    const s = setup()
    s.attention(1)
    s.attention(2)
    const buffered = vi
      .spyOn(s.pair.server, 'bufferedBytes')
      .mockImplementation(() =>
        s.write.mock.calls.length >= 2 ? s.state.limits.sendQueueBytes : 0,
      )
    reset(s.state, s.sub)
    expect(s.frames.map((frame) => frame.type)).toEqual(['lanes', 'attention'])
    expect(s.sub.cursor).toEqual({ epoch, seq: 2 })
    expect(s.sub.recovery).toEqual({ cursor: { epoch, seq: 2 }, after: { epoch, seq: 1 } })
    expect(vi.getTimerCount()).toBe(1)
    s.lanesTopic.delta([])
    s.attention(3)
    buffered.mockReturnValue(0)
    vi.advanceTimersByTime(25)
    expect(s.frames).toMatchObject([
      { type: 'lanes', cursor: { seq: 2 } },
      { type: 'attention', cursor: { seq: 1 } },
      { type: 'lanes', cursor: { seq: 4 } },
      { type: 'attention', cursor: { seq: 2 } },
      { type: 'attention', cursor: { seq: 4 } },
    ])
    expect(s.frames).toHaveLength(5)
    expect(s.sub.cursor).toEqual({ epoch, seq: 4 })
    expect(s.sub.recovery).toBeUndefined()
    expect(s.sub.stale).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    close(s.state)
  })

  it('resumes a partial attention replay without repeating the unchanged list or attention', () => {
    vi.useFakeTimers()
    const s = setup()
    s.attention(1)
    s.attention(2)
    const buffered = vi
      .spyOn(s.pair.server, 'bufferedBytes')
      .mockImplementation(() =>
        s.write.mock.calls.length >= 2 ? s.state.limits.sendQueueBytes : 0,
      )
    reset(s.state, s.sub, true)
    expect(s.sub.stale).toBe(true)
    buffered.mockReturnValue(0)
    vi.advanceTimersByTime(25)
    expect(s.frames).toMatchObject([
      { type: 'lanes', cursor: { seq: 2 } },
      { type: 'attention', cursor: { seq: 1 } },
      { type: 'attention', cursor: { seq: 2 } },
    ])
    expect(s.frames).toHaveLength(3)
    expect(s.sub.recovery).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    close(s.state)
  })

  it('advances a lane cursor only after its reset snapshot is sent', () => {
    vi.useFakeTimers()
    const s = setup('lane')
    s.streams.publish(laneId, { kind: 'dialog-resolved', dialogId: 'd' })
    const buffered = vi
      .spyOn(s.pair.server, 'bufferedBytes')
      .mockReturnValue(s.state.limits.sendQueueBytes)
    reset(s.state, s.sub, true)
    expect(s.sub.cursor).toEqual({ epoch, seq: 0 })
    expect(s.frames).toEqual([])
    buffered.mockReturnValue(0)
    vi.advanceTimersByTime(25)
    expect(s.frames).toMatchObject([
      { type: 'snapshot', reset: true, snapshot: { cursor: { epoch, seq: 1 } } },
    ])
    expect(s.sub.cursor).toEqual({ epoch, seq: 1 })
    expect(s.sub.stale).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    close(s.state)
  })

  it.each(['unknown-lane', 'too-large'] as const)(
    'removes a lane when its snapshot is %s',
    (code) => {
      const s = setup('lane')
      vi.spyOn(s.streams, 'snapshot').mockReturnValue(
        code === 'unknown-lane' ? null : { ok: false, reason: 'too-large' },
      )
      reset(s.state, s.sub)
      expect(s.frames).toEqual([{ type: 'subscribe-failed', id: 's', code }])
      expect(s.sub.drop).toHaveBeenCalledTimes(1)
      expect(s.state.subscriptions.size).toBe(0)
      expect(s.sub.cursor).toEqual({ epoch, seq: 0 })
      close(s.state)
    },
  )
})
