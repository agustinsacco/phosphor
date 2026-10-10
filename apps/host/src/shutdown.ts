import { constants } from 'node:os'
import { errorText } from '@phosphor/shared/errors'
import { EXIT } from './checks'
import type { HostLog } from './machine/log'

export const SHUTDOWN_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]

/** After a fatal error the drain gets this long, then every group is killed. */
export const FATAL_DRAIN_MS = 2000

/** A running Host: what a signal or a fatal error must stop before the process exits. */
export interface Drainable {
  /** A second call kills every group at once and returns the first call's result. */
  drain(reason: string): Promise<{ state: 'stopped' | 'failed' }>
  log: Pick<HostLog, 'write' | 'hide'>
}

export interface ShutdownIo {
  exit(code: number): void
  stderr(text: string): void
  /** Kill every version probe still running: each leads its own process group. */
  stopProbes(): void
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
 * command can finish while a signal's drain still runs.
 */
export function createShutdown(io: ShutdownIo, options: { fatalDrainMs?: number } = {}) {
  const fatalDrainMs = options.fatalDrainMs ?? FATAL_DRAIN_MS
  let current: Drainable | null = null
  // A Host this shutdown began to drain. Detaching it does not end that
  // drain, so a later signal or error must still reach it, to force it.
  let draining: Drainable | null = null
  const target = () => current ?? draining
  let exited = false
  // Set by a fatal error, so that a signal's drain ending first exits 70 too.
  let fatal = false
  const exit = (code: number) => {
    if (exited) return
    exited = true
    io.exit(fatal ? EXIT.internal : code)
  }
  async function drained(target: Drainable, reason: string): Promise<boolean> {
    draining = target
    try {
      return (await target.drain(reason)).state === 'stopped'
    } catch (error) {
      target.log.write('host', 'drain failed', { error: errorText(error) })
      return false
    }
  }
  return {
    /** Drain `target` on a signal or a fatal error until the returned function detaches it. */
    attach(target: Drainable): () => void {
      current = target
      return () => {
        if (current === target) current = null
      }
    },
    async signal(name: ShutdownSignal): Promise<void> {
      io.stopProbes()
      const code = 128 + constants.signals[name]
      const host = target()
      if (!host) return exit(code)
      host.log.write('host', 'signal', { signal: name })
      exit((await drained(host, name)) ? code : EXIT.internal)
    },
    async fatal(error: unknown): Promise<void> {
      fatal = true
      io.stopProbes()
      const host = target()
      const text = errorText(error)
      if (!host) {
        io.stderr(`phosphor: internal error: ${text}\n`)
        return exit(EXIT.internal)
      }
      host.log.write('host', 'fatal error', { error: text })
      io.stderr(`phosphor: internal error: ${host.log.hide(text)}\n`)
      const hurry = setTimeout(() => void host.drain('fatal error, hurried'), fatalDrainMs)
      try {
        await drained(host, 'fatal error')
      } finally {
        clearTimeout(hurry)
      }
      exit(EXIT.internal)
    },
  }
}

export type Shutdown = ReturnType<typeof createShutdown>
