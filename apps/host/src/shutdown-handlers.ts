import { constants } from 'node:os'
import { errorText } from '@phosphor/shared/errors'
import { EXIT } from './checks'
import type { Drainable, ShutdownIo, ShutdownSignal } from './shutdown'
import { exitShutdown, flushShutdown, type ShutdownState } from './shutdown-state'

async function drainShutdownTarget(
  state: ShutdownState,
  target: Drainable,
  reason: string,
): Promise<boolean> {
  state.draining = target
  try {
    return (await target.drain(reason)).state === 'stopped'
  } catch (error) {
    target.log.write('host', 'drain failed', { error: errorText(error) })
    return false
  }
}

export async function signalShutdown(
  state: ShutdownState,
  io: ShutdownIo,
  name: ShutdownSignal,
): Promise<void> {
  io.stopProbes()
  const code = 128 + constants.signals[name]
  const host = state.current ?? state.draining
  if (!host) return exitShutdown(state, io, code)
  host.log.write('host', 'signal', { signal: name })
  const second = state.draining !== null
  const clean = await drainShutdownTarget(state, host, name)
  exitShutdown(
    state,
    io,
    !second && host.exitCode ? host.exitCode(name, clean) : clean ? code : EXIT.internal,
  )
}

/** The command ended: a signal's or fatal error's drain still owns its exit. */
export function finishShutdown(state: ShutdownState, io: ShutdownIo, code: number): void {
  if (state.draining) return
  exitShutdown(state, io, code)
}

export async function fatalShutdown(
  state: ShutdownState,
  io: ShutdownIo,
  error: unknown,
  fatalDrainMs: number,
): Promise<void> {
  state.fatal = true
  io.stopProbes()
  const host = state.current ?? state.draining
  const text = errorText(error)
  if (!host) {
    io.stderr(`phosphor: internal error: ${text}\n`)
    // An exit already flushing waits for this message too, and exits 70.
    if (state.exited) return flushShutdown(state, io)
    return exitShutdown(state, io, EXIT.internal)
  }
  host.log.write('host', 'fatal error', { error: text })
  io.stderr(`phosphor: internal error: ${host.log.hide(text)}\n`)
  // An exit already flushing waits for this message too.
  if (state.exited) flushShutdown(state, io)
  const hurry = setTimeout(() => void host.drain('fatal error, hurried'), fatalDrainMs)
  try {
    await drainShutdownTarget(state, host, 'fatal error')
  } finally {
    clearTimeout(hurry)
  }
  exitShutdown(state, io, EXIT.internal)
}
