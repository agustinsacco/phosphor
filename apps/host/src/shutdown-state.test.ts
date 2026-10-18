import { describe, expect, it, vi } from 'vitest'
import { createShutdownState, exitShutdown, flushShutdown } from './shutdown-state'

function harness() {
  const flushes: (() => void)[] = []
  const io = {
    exit: vi.fn(),
    stderr: vi.fn(),
    stopProbes: vi.fn(),
    flush: vi.fn((done: () => void) => void flushes.push(done)),
  }
  return { state: createShutdownState(), io, flushes }
}

describe('shutdown state', () => {
  it('initializes independent idle state for each shutdown', () => {
    const state = createShutdownState()
    expect(state).toEqual({
      current: null,
      draining: null,
      exited: false,
      exitCode: 70,
      flushing: 0,
      ended: false,
      fatal: false,
    })
    state.fatal = true
    expect(createShutdownState().fatal).toBe(false)
  })

  it.each([false, true])('counts every pending flush in either settle order (%s)', (reverse) => {
    const { state, io, flushes } = harness()
    exitShutdown(state, io, 1)
    flushShutdown(state, io)
    expect(state.flushing).toBe(2)
    expect(state.exited).toBe(true)
    expect(state.ended).toBe(false)
    if (reverse) flushes.reverse()
    flushes[0]!()
    expect(state.flushing).toBe(1)
    expect(io.exit).not.toHaveBeenCalled()
    flushes[1]!()
    expect(state.flushing).toBe(0)
    expect(state.ended).toBe(true)
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('keeps the first requested exit code and exits only once, even after later flushes', () => {
    const { state, io, flushes } = harness()
    exitShutdown(state, io, 1)
    exitShutdown(state, io, 0)
    expect(io.flush).toHaveBeenCalledTimes(1)
    flushes[0]!()
    exitShutdown(state, io, 143)
    flushShutdown(state, io)
    flushes[1]!()
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(state.exitCode).toBe(1)
  })

  it('reads fatal precedence only when the final flush settles', () => {
    const { state, io, flushes } = harness()
    exitShutdown(state, io, 0)
    flushShutdown(state, io)
    flushes[0]!()
    state.fatal = true
    flushes[1]!()
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
    expect(state.exitCode).toBe(0)
  })

  it('settles immediately without a flush port and keeps that exit final', () => {
    const { state, io } = harness()
    const immediate = { exit: io.exit, stderr: io.stderr, stopProbes: io.stopProbes }
    exitShutdown(state, immediate, 0)
    state.fatal = true
    flushShutdown(state, immediate)
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(state.flushing).toBe(0)
    expect(state.ended).toBe(true)
  })
})
