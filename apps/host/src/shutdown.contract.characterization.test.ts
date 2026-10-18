import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShutdown, type Drainable } from './shutdown'

function harness() {
  const flushes: (() => void)[] = []
  const io = {
    exit: vi.fn(),
    stderr: vi.fn(),
    stopProbes: vi.fn(),
    flush: vi.fn((done: () => void) => void flushes.push(done)),
  }
  let end!: (state: 'stopped' | 'failed') => void
  const pending = new Promise<{ state: 'stopped' | 'failed' }>((resolve) => {
    end = (state) => resolve({ state })
  })
  const target: Drainable = {
    drain: vi.fn(() => pending),
    log: {
      write: vi.fn(),
      hide: vi.fn((text: string) => text.replace('secret', '[redacted]')),
    },
    exitCode: vi.fn(() => 0),
  }
  return { io, flushes, target, end, shutdown: createShutdown(io, { fatalDrainMs: 20 }) }
}

afterEach(() => vi.useRealTimers())

describe('shutdown public contract', () => {
  it('forces the draining target after detach and leaves command finish to the signal', async () => {
    const { io, flushes, target, end, shutdown } = harness()
    const detach = shutdown.attach(target)
    const first = shutdown.signal('SIGTERM')
    detach()
    shutdown.finish(1)
    const second = shutdown.signal('SIGINT')
    expect(target.drain).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(target.drain).toHaveBeenNthCalledWith(2, 'SIGINT')
    expect(io.flush).not.toHaveBeenCalled()
    end('stopped')
    await Promise.all([first, second])
    expect(target.exitCode).toHaveBeenCalledExactlyOnceWith('SIGTERM', true)
    expect(io.exit).not.toHaveBeenCalled()
    flushes[0]!()
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(io.stopProbes).toHaveBeenCalledTimes(2)
  })

  it.each(['first', 'last'] as const)(
    'overrides a pending clean exit with a redacted fatal message whose flush settles %s',
    async (order) => {
      const { io, flushes, target, end, shutdown } = harness()
      shutdown.attach(target)
      shutdown.finish(0)
      const fatal = shutdown.fatal(new Error('lost secret'))
      expect(target.log.write).toHaveBeenCalledWith('host', 'fatal error', {
        error: 'lost secret',
      })
      expect(io.stderr).toHaveBeenCalledExactlyOnceWith(
        'phosphor: internal error: lost [redacted]\n',
      )
      expect(io.flush).toHaveBeenCalledTimes(2)
      end('stopped')
      await fatal
      const [first, last] = order === 'first' ? [1, 0] : [0, 1]
      flushes[first]!()
      expect(io.exit).not.toHaveBeenCalled()
      flushes[last]!()
      expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
      shutdown.finish(0)
      expect(io.exit).toHaveBeenCalledTimes(1)
    },
  )

  it('hurries a detached fatal drain and ignores command finish until every flush settles', async () => {
    vi.useFakeTimers()
    const { io, flushes, target, end, shutdown } = harness()
    const detach = shutdown.attach(target)
    const fatal = shutdown.fatal('secret')
    detach()
    shutdown.finish(0)
    await vi.advanceTimersByTimeAsync(19)
    expect(target.drain).toHaveBeenCalledExactlyOnceWith('fatal error')
    await vi.advanceTimersByTimeAsync(1)
    expect(target.drain).toHaveBeenNthCalledWith(2, 'fatal error, hurried')
    expect(io.flush).not.toHaveBeenCalled()
    end('stopped')
    await fatal
    await shutdown.fatal('another error')
    expect(io.flush).toHaveBeenCalledTimes(2)
    flushes[1]!()
    expect(io.exit).not.toHaveBeenCalled()
    flushes[0]!()
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
  })

  it('logs a thrown drain, cancels the hurry timer and keeps the fatal code over finish', async () => {
    vi.useFakeTimers()
    const { io, flushes, target, shutdown } = harness()
    target.drain = vi.fn(() => {
      throw new Error('drain broke')
    })
    shutdown.attach(target)
    await shutdown.fatal('secret')
    shutdown.finish(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(target.drain).toHaveBeenCalledExactlyOnceWith('fatal error')
    expect(target.log.write).toHaveBeenNthCalledWith(1, 'host', 'fatal error', {
      error: 'secret',
    })
    expect(target.log.write).toHaveBeenNthCalledWith(2, 'host', 'drain failed', {
      error: 'drain broke',
    })
    expect(io.stderr).toHaveBeenCalledExactlyOnceWith('phosphor: internal error: [redacted]\n')
    flushes[0]!()
    expect(io.exit).toHaveBeenCalledExactlyOnceWith(70)
  })
})
