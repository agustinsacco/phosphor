import { createShutdownState } from './shutdown-state'
import { fatalShutdown, finishShutdown, signalShutdown } from './shutdown-handlers'
import type { HostLog } from './machine/log'

export const SHUTDOWN_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]

/** After a fatal error the drain gets this long, then every group is killed. */
export const FATAL_DRAIN_MS = 2000

/** How long an exit waits for stdout and stderr to flush. */
export const EXIT_FLUSH_MS = 1000

/**
 * A flush that calls `done` once what was written to `streams` has reached
 * its reader, or after `ms`: a reader that stopped reading must not keep the
 * Host.
 */
export function flushStreams(
  streams: readonly { write(chunk: string, done: () => void): unknown }[],
  ms = EXIT_FLUSH_MS,
): (done: () => void) => void {
  return (done) => {
    let pending = streams.length
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      done()
    }
    const timer = setTimeout(end, ms)
    for (const stream of streams) stream.write('', () => --pending === 0 && end())
  }
}

/** A running Host: what a signal or a fatal error must stop before the process exits. */
export interface Drainable {
  /** A second call kills every group at once and returns the first call's result. */
  drain(reason: string): Promise<{ state: 'stopped' | 'failed' }>
  log: Pick<HostLog, 'write' | 'hide'>
  /** A command may choose its first clean signal exit; later signals keep their number. */
  exitCode?(signal: ShutdownSignal, drained: boolean): number
}

export interface ShutdownIo {
  exit(code: number): void
  stderr(text: string): void
  /** Kill every version probe still running: each leads its own process group. */
  stopProbes(): void
  /** Call `done` once stdout and stderr have flushed. Without it, an exit is immediate. */
  flush?(done: () => void): void
}

/**
 * How the Host ends on a signal or a fatal error. With nothing attached it
 * kills its probes and exits at once. With a running Host attached, a signal
 * drains it first and exits 128 + the signal's number, or 70 when the drain
 * failed; a second signal kills every group at once. A fatal error is logged
 * redacted, drained for `fatalDrainMs` at most, and exits 70, even when a
 * signal's drain was already under way: its call forces that drain, and
 * whichever caller exits, the code is 70. A drain once begun stays the
 * target of every later signal, even after its command detaches the Host: a
 * command can finish while a signal's drain still runs. A command's end
 * exits too, with its code, unless such a drain decides it: the pipes of a
 * pi whose stop never ended, held open by a process that left its group,
 * would otherwise keep the Host running. Every exit flushes first, and its
 * code is read only once the flush ends, so a fatal error during it still
 * exits 70, its message flushed too.
 */
export function createShutdown(io: ShutdownIo, options: { fatalDrainMs?: number } = {}) {
  const fatalDrainMs = options.fatalDrainMs ?? FATAL_DRAIN_MS
  const state = createShutdownState()
  return {
    /** Drain `target` on a signal or a fatal error until the returned function detaches it. */
    attach(target: Drainable): () => void {
      state.current = target
      return () => {
        if (state.current === target) state.current = null
      }
    },
    signal: (name: ShutdownSignal) => signalShutdown(state, io, name),
    /** The command ended with `code`: exit, unless a signal's or a fatal error's drain will. */
    finish: (code: number) => finishShutdown(state, io, code),
    fatal: (error: unknown) => fatalShutdown(state, io, error, fatalDrainMs),
  }
}

export type Shutdown = ReturnType<typeof createShutdown>
