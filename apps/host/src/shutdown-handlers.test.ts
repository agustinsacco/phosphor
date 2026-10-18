import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Drainable } from './shutdown'
import { fatalShutdown, finishShutdown, signalShutdown } from './shutdown-handlers'
import { createShutdownState } from './shutdown-state'

function harness() {
  const state = createShutdownState()
  const io = { exit: vi.fn(), stderr: vi.fn(), stopProbes: vi.fn() }
  const host: Drainable = {
    drain: vi.fn<Drainable['drain']>(async () => ({ state: 'stopped' })),
    log: { write: vi.fn(), hide: vi.fn(() => '[redacted]') },
  }
  return { state, io, host }
}

function pendingDrain() {
  let end!: () => void
  const pending = new Promise<{ state: 'stopped' }>((resolve) => {
    end = () => resolve({ state: 'stopped' })
  })
  return { drain: vi.fn(() => pending), end }
}

afterEach(() => vi.useRealTimers())

describe('shutdown handlers', () => {
  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('stops probes before exiting without a target on %s', async (name, code) => {
    const { state, io } = harness()
    await signalShutdown(state, io, name)
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(code)
    expect(io.stopProbes.mock.invocationCallOrder[0]).toBeLessThan(
      io.exit.mock.invocationCallOrder[0]!,
    )
  })

  it('keeps the detached drain target, ignoring finish and using the second signal code', async () => {
    const { state, io, host } = harness()
    const pending = pendingDrain()
    const firstCode = vi.fn(() => 0)
    state.current = { ...host, drain: pending.drain, exitCode: firstCode }
    const first = signalShutdown(state, io, 'SIGTERM')
    const retained = state.current
    state.current = null
    finishShutdown(state, io, 1)
    // The second drain can settle first, but still cannot use the command's clean code.
    retained.drain = vi.fn<Drainable['drain']>(async () => ({ state: 'stopped' }))
    await signalShutdown(state, io, 'SIGINT')
    expect(state.draining).toBe(retained)
    expect(retained.drain).toHaveBeenCalledExactlyOnceWith('SIGINT')
    expect(firstCode).not.toHaveBeenCalled()
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(130)
    pending.end()
    await first
    expect(io.exit).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'throw'] as const)(
    'logs thrown drains and exits 70 for %s',
    async (outcome) => {
      const { state, io, host } = harness()
      host.drain = vi.fn<Drainable['drain']>(async () => {
        if (outcome === 'throw') throw new Error('broken')
        return { state: 'failed' }
      })
      state.current = host
      await signalShutdown(state, io, 'SIGTERM')
      expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
      expect(host.log.write).toHaveBeenCalledWith('host', 'signal', { signal: 'SIGTERM' })
      if (outcome === 'throw')
        expect(host.log.write).toHaveBeenLastCalledWith('host', 'drain failed', {
          error: 'broken',
        })
      else expect(host.log.write).toHaveBeenCalledTimes(1)
    },
  )

  it('lets the first signal choose the command exit code from its drain result', async () => {
    const { state, io, host } = harness()
    host.drain = vi.fn<Drainable['drain']>(async () => ({ state: 'failed' }))
    host.exitCode = vi.fn(() => 77)
    state.current = host
    await signalShutdown(state, io, 'SIGHUP')
    expect(host.exitCode).toHaveBeenCalledExactlyOnceWith('SIGHUP', false)
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(77)
  })

  it('prints an unattached fatal error before exiting 70', async () => {
    const { state, io } = harness()
    await fatalShutdown(state, io, new Error('broken'), 20)
    expect(io.stderr).toHaveBeenCalledExactlyOnceWith('phosphor: internal error: broken\n')
    expect(io.stderr.mock.invocationCallOrder[0]).toBeLessThan(io.exit.mock.invocationCallOrder[0]!)
    expect(state.fatal).toBe(true)
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
  })

  it('forces a detached signal drain on fatal, redacts stderr and hurries only until drained', async () => {
    vi.useFakeTimers()
    const { state, io, host } = harness()
    const pending = pendingDrain()
    host.drain = pending.drain
    state.current = host
    const signal = signalShutdown(state, io, 'SIGTERM')
    state.current = null
    const fatal = fatalShutdown(state, io, new Error('secret'), 20)
    finishShutdown(state, io, 0)
    expect(host.log.write).toHaveBeenCalledWith('host', 'fatal error', { error: 'secret' })
    expect(io.stderr).toHaveBeenCalledExactlyOnceWith('phosphor: internal error: [redacted]\n')
    await vi.advanceTimersByTimeAsync(19)
    expect(host.drain).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.drain).toHaveBeenNthCalledWith(3, 'fatal error, hurried')
    expect(io.exit).not.toHaveBeenCalled()
    pending.end()
    await Promise.all([signal, fatal])
    await vi.advanceTimersByTimeAsync(100)
    expect(host.drain).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
  })

  it('cancels the fatal hurry when a drain throws and leaves finish to that drain', async () => {
    vi.useFakeTimers()
    const { state, io, host } = harness()
    host.drain = vi.fn(() => {
      throw 'broken'
    })
    state.current = host
    await fatalShutdown(state, io, 'secret', 20)
    finishShutdown(state, io, 0)
    await vi.advanceTimersByTimeAsync(100)
    expect(host.log.write).toHaveBeenLastCalledWith('host', 'drain failed', { error: 'broken' })
    expect(host.drain).toHaveBeenCalledExactlyOnceWith('fatal error')
    expect(vi.getTimerCount()).toBe(0)
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
  })
})
