import type { StreamLog } from '../stream'

export type Listener<T> = (frame: T | null) => void

export interface DispatchState<T> {
  listeners: Set<Listener<T>>
  limit: number
  log: StreamLog | undefined
  metadata: Parameters<StreamLog>[1]
  queue: (T | null)[]
  dispatching: boolean
  pending: boolean
}

export function createDispatchState<T>(
  limit: number,
  log: StreamLog | undefined,
  metadata: Parameters<StreamLog>[1],
): DispatchState<T> {
  return {
    listeners: new Set(),
    limit,
    log,
    metadata,
    queue: [],
    dispatching: false,
    pending: false,
  }
}

function notify<T>(listeners: Set<Listener<T>>, frame: T | null) {
  // New subscribers start at the current cursor, never with this in-flight frame.
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener(frame)
    } catch {
      /* A viewer never stops another viewer or pi. */
    }
  }
}

function deliverReset<T>(state: DispatchState<T>) {
  state.pending = false
  deliverFrame(state, null)
}

function deferReset<T>(state: DispatchState<T>) {
  state.queue.length = 0
  state.pending = true
  const log = state.log
  try {
    log?.('lane.stream_reentrant_overflow', state.metadata)
  } catch {
    /* Safe metadata only. */
  }
  setImmediate(deliverReset<T>, state)
}

export function deliverFrame<T>(state: DispatchState<T>, frame: T | null): void {
  if (state.pending) return
  state.queue.push(frame)
  if (state.queue.length > state.limit) deferReset(state)
  if (state.dispatching || state.pending) return
  state.dispatching = true
  let drained = 0
  try {
    while (state.queue.length && !state.pending) {
      if (++drained > state.limit) {
        deferReset(state)
        break
      }
      const next = state.queue.shift()
      if (next !== undefined) notify(state.listeners, next)
    }
  } finally {
    state.dispatching = false
  }
}
