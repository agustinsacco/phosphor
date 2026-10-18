import { HOST_LIMITS, utf8Length } from '../host-protocol'

export interface LoopbackOptions {
  inboundFrameBytes?: number
  outboundFrameBytes?: number
  queueBytes?: number
}

export interface LoopbackState {
  readonly inbound: number
  readonly outbound: number
  readonly cap: number
  open: boolean
  paused: boolean
  dropped: number
  queuedBytes: number
  scheduled: boolean
  readonly queue: { to: number; text: string; bytes: number }[]
  readonly messages: ((text: string) => void)[][]
  readonly closes: ((code: number, reason: string) => void)[][]
}

function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error('Invalid loopback limit')
  return value
}

export function createLoopbackState(options: LoopbackOptions = {}): LoopbackState {
  return {
    inbound: limit(options.inboundFrameBytes, HOST_LIMITS.inboundFrameBytes),
    outbound: limit(options.outboundFrameBytes, HOST_LIMITS.outboundFrameBytes),
    cap: limit(options.queueBytes, HOST_LIMITS.sendQueueBytes),
    open: true,
    paused: false,
    dropped: 0,
    queuedBytes: 0,
    scheduled: false,
    queue: [],
    messages: [[], []],
    closes: [[], []],
  }
}

export function closeLoopback(state: LoopbackState, code: number, reason: string): void {
  if (!state.open) return
  state.open = false
  state.queue.length = 0
  state.queuedBytes = 0
  queueMicrotask(() => {
    for (const side of state.closes) for (const cb of side) cb(code, reason)
  })
}

function flushLoopback(state: LoopbackState): void {
  state.scheduled = false
  if (state.paused || !state.open) return
  while (state.queue.length && !state.paused && state.open) {
    const next = state.queue.shift()
    if (!next) break
    state.queuedBytes -= next.bytes
    // Pause/close interrupts the queue, not the remaining listeners of this frame.
    for (const cb of state.messages[next.to] ?? []) cb(next.text)
  }
}

export function scheduleLoopback(state: LoopbackState): void {
  if (!state.scheduled) {
    state.scheduled = true
    queueMicrotask(() => flushLoopback(state))
  }
}

export function sendLoopback(state: LoopbackState, side: number, text: string): void {
  if (!state.open) throw new Error('Socket closed')
  const bytes = utf8Length(text)
  if (side === 1 && bytes > state.outbound) throw new Error('Outbound frame too large')
  if (side === 0 && bytes > state.inbound) {
    closeLoopback(state, 4400, 'Frame too large')
    return
  }
  if (state.dropped > 0) {
    state.dropped--
    return
  }
  if (state.queuedBytes + bytes > state.cap) {
    closeLoopback(state, 4429, 'Transport queue full')
    return
  }
  state.queue.push({ to: 1 - side, text, bytes })
  state.queuedBytes += bytes
  scheduleLoopback(state)
}

export function bufferedLoopbackBytes(state: LoopbackState, side: number): number {
  return state.queue.filter((q) => q.to === 1 - side).reduce((sum, q) => sum + q.bytes, 0)
}

export function dropLoopbackMessages(state: LoopbackState, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid drop count')
  state.dropped = n
}
