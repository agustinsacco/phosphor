import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShutdown, flushStreams, type Drainable } from './shutdown'

afterEach(() => {
  vi.useRealTimers()
})

function harness(options: { fatalDrainMs?: number } = {}) {
  const calls: string[] = []
  const io = {
    exit: vi.fn((code: number) => void calls.push(`exit ${code}`)),
    stderr: vi.fn((text: string) => void calls.push(`stderr ${text}`)),
    stopProbes: vi.fn(() => void calls.push('stopProbes')),
  }
  return { calls, io, shutdown: createShutdown(io, options) }
}

/** A Host whose drain ends when the test says, as `stopped` or `failed`. */
function host(secret = 'sk-secret') {
  const drains: string[] = []
  const writes: [string, string, unknown][] = []
  let end!: (state: 'stopped' | 'failed') => void
  const ended = new Promise<{ state: 'stopped' | 'failed' }>((resolve) => {
    end = (state) => resolve({ state })
  })
  const target: Drainable = {
    drain: (reason) => {
      drains.push(reason)
      return ended
    },
    log: {
      write: (scope, message, data) => void writes.push([scope, message, data]),
      hide: (text) => text.split(secret).join('[redacted]'),
    },
  }
  return { target, drains, writes, end }
}

describe('shutdown', () => {
  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'with nothing running, %s stops the probes and exits %i at once',
    async (name, code) => {
      const { calls, shutdown } = harness()
      await shutdown.signal(name)
      expect(calls).toEqual(['stopProbes', `exit ${code}`])
    },
  )

  it('drains a running Host before it exits on a signal', async () => {
    const { calls, io, shutdown } = harness()
    const { target, drains, writes, end } = host()
    shutdown.attach(target)
    const done = shutdown.signal('SIGTERM')
    await Promise.resolve()
    expect(drains).toEqual(['SIGTERM'])
    expect(io.exit).not.toHaveBeenCalled()
    expect(writes).toContainEqual(['host', 'signal', { signal: 'SIGTERM' }])
    end('stopped')
    await done
    expect(calls).toEqual(['stopProbes', 'exit 143'])
  })

  it('kills every group on a second signal, and exits once', async () => {
    const { io, shutdown } = harness()
    const { target, drains, end } = host()
    shutdown.attach(target)
    const first = shutdown.signal('SIGINT')
    const second = shutdown.signal('SIGINT')
    await Promise.resolve()
    // A second drain call is what forces the drain: see createDrain.
    expect(drains).toEqual(['SIGINT', 'SIGINT'])
    end('stopped')
    await Promise.all([first, second])
    expect(io.exit.mock.calls).toEqual([[130]])
  })

  it('forces a drain begun before its command detached, rather than exit and leave pi', async () => {
    const { io, shutdown } = harness()
    const { target, drains, end } = host()
    const detach = shutdown.attach(target)
    const first = shutdown.signal('SIGTERM')
    // The signal's drain makes the command fail and finish, and it detaches.
    detach()
    const second = shutdown.signal('SIGTERM')
    await Promise.resolve()
    expect(drains).toEqual(['SIGTERM', 'SIGTERM'])
    expect(io.exit).not.toHaveBeenCalled()
    end('stopped')
    await Promise.all([first, second])
    expect(io.exit.mock.calls).toEqual([[143]])
  })

  it('exits 70 when the drain fails or throws, and logs why', async () => {
    const failed = harness()
    const a = host()
    failed.shutdown.attach(a.target)
    const done = failed.shutdown.signal('SIGTERM')
    a.end('failed')
    await done
    expect(failed.io.exit.mock.calls).toEqual([[70]])

    const threw = harness()
    const b = host()
    threw.shutdown.attach({ ...b.target, drain: () => Promise.reject(new Error('boom')) })
    await threw.shutdown.signal('SIGHUP')
    expect(threw.io.exit.mock.calls).toEqual([[70]])
    expect(b.writes).toContainEqual(['host', 'drain failed', { error: 'boom' }])
  })

  it('exits at once again once the Host is detached', async () => {
    const { calls, shutdown } = harness()
    const { target, drains } = host()
    const detach = shutdown.attach(target)
    detach()
    await shutdown.signal('SIGTERM')
    expect(drains).toEqual([])
    expect(calls).toEqual(['stopProbes', 'exit 143'])
  })

  it('reports a fatal error with nothing running and exits 70', async () => {
    const { calls, shutdown } = harness()
    await shutdown.fatal(new Error('broken'))
    expect(calls).toEqual(['stopProbes', 'stderr phosphor: internal error: broken\n', 'exit 70'])
  })

  it('logs a fatal error, prints it redacted, drains, and hurries a drain that runs long', async () => {
    vi.useFakeTimers()
    const { calls, io, shutdown } = harness({ fatalDrainMs: 2000 })
    const { target, drains, writes, end } = host()
    shutdown.attach(target)
    const done = shutdown.fatal(new Error('lost sk-secret'))
    await vi.advanceTimersByTimeAsync(1999)
    expect(drains).toEqual(['fatal error'])
    expect(writes).toContainEqual(['host', 'fatal error', { error: 'lost sk-secret' }])
    expect(calls).toContain('stderr phosphor: internal error: lost [redacted]\n')
    await vi.advanceTimersByTimeAsync(1)
    expect(drains).toEqual(['fatal error', 'fatal error, hurried'])
    expect(io.exit).not.toHaveBeenCalled()
    end('stopped')
    await done
    expect(io.exit.mock.calls).toEqual([[70]])
  })

  it.each(['attached', 'detached'] as const)(
    'exits 70 on a fatal error during a signal drain, whichever ends first (Host %s)',
    async (state) => {
      const { io, shutdown } = harness()
      const { target, drains, end } = host()
      const detach = shutdown.attach(target)
      const signalled = shutdown.signal('SIGTERM')
      // The command that attached it may finish while the signal's drain runs.
      if (state === 'detached') detach()
      const failed = shutdown.fatal(new Error('boom'))
      await Promise.resolve()
      // The fatal error's call forces the signal's drain.
      expect(drains).toEqual(['SIGTERM', 'fatal error'])
      end('stopped')
      await Promise.all([signalled, failed])
      expect(io.exit.mock.calls).toEqual([[70]])
    },
  )

  it("exits with the command's code when it finishes, once", async () => {
    const { io, shutdown } = harness()
    shutdown.finish(1)
    shutdown.finish(0)
    await shutdown.signal('SIGTERM')
    expect(io.exit.mock.calls).toEqual([[1]])
  })

  it("leaves the exit to a signal's drain still running when its command finishes", async () => {
    const { io, shutdown } = harness()
    const { target, end } = host()
    const detach = shutdown.attach(target)
    const signalled = shutdown.signal('SIGTERM')
    detach()
    shutdown.finish(0)
    expect(io.exit).not.toHaveBeenCalled()
    end('stopped')
    await signalled
    expect(io.exit.mock.calls).toEqual([[143]])
  })

  it('does not hurry a drain that ends in time', async () => {
    vi.useFakeTimers()
    const { io, shutdown } = harness({ fatalDrainMs: 2000 })
    const { target, drains, end } = host()
    shutdown.attach(target)
    const done = shutdown.fatal('not an Error')
    end('stopped')
    await done
    await vi.advanceTimersByTimeAsync(5000)
    expect(drains).toEqual(['fatal error'])
    expect(io.exit.mock.calls).toEqual([[70]])
  })
})

describe('flushStreams', () => {
  /** A stream whose writes call back when the test says. */
  function stream() {
    const pending: (() => void)[] = []
    return { pending, write: (_: string, done: () => void) => void pending.push(done) }
  }

  it('is done once every stream has flushed', () => {
    const done = vi.fn()
    const [out, err] = [stream(), stream()]
    flushStreams([out, err])(done)
    out.pending[0]!()
    expect(done).not.toHaveBeenCalled()
    err.pending[0]!()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('is done after its limit when a stream never flushes, and only once', () => {
    vi.useFakeTimers()
    const done = vi.fn()
    const [out, err] = [stream(), stream()]
    flushStreams([out, err], 1000)(done)
    out.pending[0]!()
    vi.advanceTimersByTime(999)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledTimes(1)
    // A flush that arrives late is not done again.
    err.pending[0]!()
    expect(done).toHaveBeenCalledTimes(1)
  })
})

describe('an exit that flushes', () => {
  /** A shutdown whose flushes end when the test says. */
  function flushing() {
    const flushes: (() => void)[] = []
    const { calls, io } = harness()
    const held = { ...io, flush: vi.fn((done: () => void) => void flushes.push(done)) }
    return { calls, io: held, flushes, shutdown: createShutdown(held) }
  }

  it("exits with the command's code once its flush ends", () => {
    const { io, flushes, shutdown } = flushing()
    shutdown.finish(0)
    expect(io.exit).not.toHaveBeenCalled()
    flushes[0]!()
    expect(io.exit.mock.calls).toEqual([[0]])
  })

  it('keeps the first code asked for while its flush runs', () => {
    const { io, flushes, shutdown } = flushing()
    shutdown.finish(1)
    void shutdown.signal('SIGTERM')
    shutdown.finish(0)
    for (const done of flushes) done()
    expect(io.exit.mock.calls).toEqual([[1]])
  })

  it("waits for a fatal error's message when a signal's drain has ended and its exit flushes", async () => {
    const { calls, io, flushes, shutdown } = flushing()
    const { target, end } = host()
    shutdown.attach(target)
    const signalled = shutdown.signal('SIGTERM')
    end('stopped')
    await signalled
    expect(io.flush).toHaveBeenCalledTimes(1)
    await shutdown.fatal(new Error('boom'))
    expect(calls).toContain('stderr phosphor: internal error: boom\n')
    expect(io.flush).toHaveBeenCalledTimes(2)
    flushes[0]!()
    expect(io.exit).not.toHaveBeenCalled()
    flushes[1]!()
    expect(io.exit.mock.calls).toEqual([[70]])
  })

  it.each([
    ['a command', (shutdown: ReturnType<typeof createShutdown>) => void shutdown.finish(0)],
    ['a signal', (shutdown: ReturnType<typeof createShutdown>) => void shutdown.signal('SIGTERM')],
  ])(
    'exits 70 on a fatal error while the exit of %s flushes, its message flushed too',
    async (_, ending) => {
      const { calls, io, flushes, shutdown } = flushing()
      ending(shutdown)
      await shutdown.fatal(new Error('boom'))
      expect(calls).toContain('stderr phosphor: internal error: boom\n')
      // The exit waits for a second flush, which carries the message.
      expect(io.flush).toHaveBeenCalledTimes(2)
      flushes[0]!()
      expect(io.exit).not.toHaveBeenCalled()
      flushes[1]!()
      expect(io.exit.mock.calls).toEqual([[70]])
    },
  )
})
