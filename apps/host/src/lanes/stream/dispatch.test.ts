import { describe, expect, it, vi } from 'vitest'
import { createDispatchState, deliverFrame } from './dispatch'

describe('bounded stream dispatch state', () => {
  it('drains reentrant frames and explicit resets in FIFO order without nesting delivery', () => {
    const state = createDispatchState<number>(10, undefined, { laneId: 'a' })
    const early: (number | null)[] = []
    const late: (number | null)[] = []
    state.listeners.add((frame) => {
      early.push(frame)
      if (frame === 1) {
        deliverFrame(state, null)
        deliverFrame(state, 2)
      }
    })
    state.listeners.add((frame) => late.push(frame))
    deliverFrame(state, 1)
    expect(early).toEqual([1, null, 2])
    expect(late).toEqual(early)
    expect(state.dispatching).toBe(false)
    expect(state.queue).toEqual([])
    deliverFrame(state, 3)
    expect(late).toEqual([1, null, 2, 3])
  })

  it('skips removed listeners and adds new listeners only for subsequent frames', () => {
    const state = createDispatchState<number>(10, undefined, { laneId: 'a' })
    const late = vi.fn()
    const removed = vi.fn()
    const survivor = vi.fn()
    state.listeners.add((frame) => {
      state.listeners.add(late)
      state.listeners.delete(removed)
      if (frame === 1) deliverFrame(state, 2)
      throw new Error('viewer failure')
    })
    state.listeners.add(removed)
    state.listeners.add(survivor)
    deliverFrame(state, 1)
    expect(removed).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledExactlyOnceWith(2)
    expect(survivor.mock.calls).toEqual([[1], [2]])
    expect(state.dispatching).toBe(false)
  })

  it('allows exactly the drain limit without scheduling a reset', () => {
    const log = vi.fn()
    const state = createDispatchState<number>(2, log, { laneId: 'a' })
    const seen: (number | null)[] = []
    state.listeners.add((frame) => {
      seen.push(frame)
      if (frame === 1) deliverFrame(state, 2)
    })
    deliverFrame(state, 1)
    expect(seen).toEqual([1, 2])
    expect(log).not.toHaveBeenCalled()
    expect(state.pending).toBe(false)
  })

  it('coalesces queue overflow, ignores pending sends and survives a throwing logger', async () => {
    const log = vi.fn(() => {
      throw new Error('logger failure')
    })
    const state = createDispatchState<number>(2, log, { laneId: 'a' })
    const seen: (number | null)[] = []
    state.listeners.add((frame) => {
      if (frame === 1) {
        deliverFrame(state, 2)
        deliverFrame(state, 3)
        deliverFrame(state, 4)
      }
      if (frame === null) deliverFrame(state, 6)
    })
    state.listeners.add((frame) => seen.push(frame))
    deliverFrame(state, 1)
    deliverFrame(state, null)
    deliverFrame(state, 5)
    expect(state.pending).toBe(true)
    expect(state.queue).toEqual([])
    expect(seen).toEqual([1])
    expect(log).toHaveBeenCalledExactlyOnceWith('lane.stream_reentrant_overflow', { laneId: 'a' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(seen).toEqual([1, null, 6])
    expect(state.pending).toBe(false)
    deliverFrame(state, 7)
    expect(seen).toEqual([1, null, 6, 7])
  })

  it('bounds total draining even when the queue never exceeds one frame', async () => {
    const log = vi.fn()
    const state = createDispatchState<number>(2, log, { topic: 'lanes' })
    const seen: (number | null)[] = []
    state.listeners.add((frame) => {
      if (frame !== null && frame < 5) deliverFrame(state, frame + 1)
    })
    state.listeners.add((frame) => seen.push(frame))
    deliverFrame(state, 1)
    expect(seen).toEqual([1, 2])
    expect(log).toHaveBeenCalledExactlyOnceWith('lane.stream_reentrant_overflow', {
      topic: 'lanes',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(seen).toEqual([1, 2, null])
    expect(state.dispatching).toBe(false)
    expect(state.pending).toBe(false)
    deliverFrame(state, 5)
    expect(seen).toEqual([1, 2, null, 5])
  })
})
