import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { createLaneStreams, createLanesTopic, streamLimits } from '../stream'
import { close, fail, remove, send, stale } from './delivery'
import type { Subscription, SubscriptionState } from './state'

function setup() {
  const pair = createLoopbackPair()
  const state: SubscriptionState = {
    socket: pair.server,
    streams: createLaneStreams({ epoch: '0123456789abcdef', snapshot: () => null }),
    lanesTopic: createLanesTopic({
      epoch: '0123456789abcdef',
      list: () => ({ lanes: [], repositories: [] }),
    }),
    limits: streamLimits({ sendQueueBytes: 1000 }),
    log: vi.fn(),
    subscriptions: new Map(),
    closed: false,
  }
  const sub: Subscription = {
    request: { type: 'subscribe', topic: 'lanes', id: 'private-id', trace: 'abcdef0123456789' },
    stale: false,
    drop: vi.fn(),
  }
  state.subscriptions.set(sub.request.id, sub)
  return { pair, state, sub, recover: vi.fn() }
}
const frame: HostFrame = { type: 'subscribe-failed', id: 's', code: 'too-large' }
afterEach(() => vi.useRealTimers())

describe('subscription delivery', () => {
  it('accepts the exact prospective backlog and discards a frame one byte over it', () => {
    vi.useFakeTimers()
    const { pair, state, sub, recover } = setup()
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    const buffered = vi.spyOn(pair.server, 'bufferedBytes').mockReturnValue(1000 - bytes)
    const writes = vi.spyOn(pair.server, 'send')
    expect(send(state, sub, frame, recover)).toBe('sent')
    buffered.mockReturnValue(1001 - bytes)
    expect(send(state, sub, frame, recover)).toBe('stale')
    expect(writes).toHaveBeenCalledTimes(1)
    expect(sub.stale).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    close(state)
  })

  it('rejects oversized and unserializable frames without starting recovery', () => {
    vi.useFakeTimers()
    const { state, sub, recover } = setup()
    state.limits.outboundFrameBytes = Buffer.byteLength(JSON.stringify(frame)) - 1
    expect(send(state, sub, frame, recover)).toBe('large')
    const circular = { ...frame, self: {} }
    circular.self = circular
    expect(send(state, sub, circular, recover)).toBe('large')
    expect(vi.getTimerCount()).toBe(0)
    expect(sub.stale).toBe(false)
    close(state)
  })

  it('drops listeners and the timer exactly once even when send and close throw', () => {
    vi.useFakeTimers()
    const { pair, state, sub, recover } = setup()
    stale(state, sub, recover)
    vi.spyOn(pair.server, 'send').mockImplementation(() => {
      throw new Error('private send')
    })
    const transportClose = vi.spyOn(pair.server, 'close').mockImplementation(() => {
      throw new Error('private close')
    })
    expect(send(state, sub, frame, recover)).toBe('stale')
    expect(transportClose).toHaveBeenCalledExactlyOnceWith(4429, 'Send failed')
    close(state)
    remove(state, sub.request.id)
    expect(sub.drop).toHaveBeenCalledTimes(1)
    expect(state.subscriptions.size).toBe(0)
    expect(state.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one 25ms timer, recovers strictly below half and stops on unsubscribe', () => {
    vi.useFakeTimers()
    const { pair, state, sub, recover } = setup()
    const buffered = vi.spyOn(pair.server, 'bufferedBytes').mockReturnValue(500)
    stale(state, sub, recover)
    stale(state, sub, recover)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(25)
    expect(recover).not.toHaveBeenCalled()
    buffered.mockReturnValue(499)
    vi.advanceTimersByTime(24)
    expect(recover).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(recover).toHaveBeenCalledExactlyOnceWith(sub)
    remove(state, sub.request.id)
    expect(vi.getTimerCount()).toBe(0)
    expect(sub.drop).toHaveBeenCalledTimes(1)
  })

  it('closes listeners when polling finds a disconnected transport', () => {
    vi.useFakeTimers()
    const { pair, state, sub, recover } = setup()
    stale(state, sub, recover)
    vi.spyOn(pair.server, 'isOpen').mockReturnValue(false)
    vi.advanceTimersByTime(25)
    expect(sub.drop).toHaveBeenCalledTimes(1)
    expect(state.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(recover).not.toHaveBeenCalled()
  })

  it('logs fixed safe failure metadata and tolerates logger errors', () => {
    const { pair, state, sub } = setup()
    const log = vi.spyOn(state, 'log').mockImplementation(() => {
      throw new Error('private log')
    })
    const writes = vi.spyOn(pair.server, 'send')
    fail(state, sub.request, 'bad-request', false)
    expect(log.mock.calls).toEqual([
      [
        'lanes.subscribe_failed',
        { topic: 'lanes', code: 'bad-request', trace: 'abcdef0123456789' },
      ],
    ])
    expect(writes).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ type: 'subscribe-failed', id: 'private-id', code: 'bad-request' }),
    )
    expect(sub.drop).not.toHaveBeenCalled()
    fail(state, sub.request, 'too-large')
    expect(sub.drop).toHaveBeenCalledTimes(1)
    close(state)
  })
})
