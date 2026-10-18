import { EXIT } from './checks'
import type { Drainable, ShutdownIo } from './shutdown'

export interface ShutdownState {
  current: Drainable | null
  /** Detaching a Host does not end its drain: later signals must still force it. */
  draining: Drainable | null
  /** An exit was requested; it happens once every flush ends. */
  exited: boolean
  exitCode: number
  flushing: number
  ended: boolean
  /** Overrides the requested code until the final flush settles. */
  fatal: boolean
}

export function createShutdownState(): ShutdownState {
  return {
    current: null,
    draining: null,
    exited: false,
    exitCode: EXIT.internal,
    flushing: 0,
    ended: false,
    fatal: false,
  }
}

function settleShutdown(state: ShutdownState, io: ShutdownIo): void {
  if (--state.flushing > 0 || state.ended) return
  state.ended = true
  io.exit(state.fatal ? EXIT.internal : state.exitCode)
}

export function flushShutdown(state: ShutdownState, io: ShutdownIo): void {
  state.flushing++
  if (io.flush) io.flush(() => settleShutdown(state, io))
  else settleShutdown(state, io)
}

export function exitShutdown(state: ShutdownState, io: ShutdownIo, code: number): void {
  if (state.exited) return
  state.exited = true
  state.exitCode = code
  flushShutdown(state, io)
}
