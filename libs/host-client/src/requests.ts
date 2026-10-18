import {
  HOST_LIMITS,
  type ClientFrame,
  type HostFrame,
  type Receipt,
} from '@phosphor/shared/host-protocol'
import type { TraceLog } from './ports'

export type NotSent = {
  requestId: string
  status: 'not-sent'
  reason: 'too-large' | 'too-many-pending' | 'not-connected' | 'closed'
}
export type CommandResult = Receipt | NotSent
type Command = Extract<ClientFrame, { type: 'command' }>
type Result = Extract<HostFrame, { type: 'result' }>
type Timer = ReturnType<typeof setTimeout>

/** A command older than this is asked about with receipt-status, never resent. */
const UNCERTAIN_AFTER_MS = 60000
const CALL_TIMEOUT_MS = 30000
const REPLAY_RETRY_MS = 250

/** A written command awaiting its receipt. `statusOnly` forbids resending it. */
interface PendingCommand {
  frame: Command
  at: number
  statusOnly: boolean
  resolve: (result: CommandResult) => void
}

/** One connection's requests. Receipts outlive a transport; calls do not. */
export interface PendingState {
  readonly pending: Map<string, PendingCommand>
  /** Raw in-flight deadlines: only a receipt or close clears them, never a reconnect. */
  readonly expiries: Map<string, Timer>
  readonly calls: Map<string, { resolve: (result: Result) => void; timer: Timer }>
  /** Request ids still to replay after a reconnect, in insertion order. */
  readonly replay: string[]
}

export interface RequestPorts {
  now: () => number
  write: (frame: ClientFrame) => boolean
  later: (fn: () => void, ms: number) => Timer
  canReplay: () => boolean
  unrefTimer?: (timer: Timer) => void
  changed: () => void
  transportFailed: () => void
  hostId: string
  log: TraceLog
}

export function createPendingState(): PendingState {
  return { pending: new Map(), expiries: new Map(), calls: new Map(), replay: [] }
}

function callFailure(id: string, message: string): Result {
  return { type: 'result', id, ok: false, error: { code: 'internal', message } }
}

/** The age is rechecked on every attempt, so a retried replay can turn into a status query. */
function replayFrame(p: PendingCommand, ports: RequestPorts): ClientFrame {
  return p.statusOnly || ports.now() - p.at >= UNCERTAIN_AFTER_MS
    ? { type: 'receipt-status', requestId: p.frame.requestId }
    : p.frame
}

/** Replays in order; a full send queue stops the drain and retries the same entry later. */
export function flushReplay(state: PendingState, ports: RequestPorts): void {
  while (state.replay.length) {
    const requestId = state.replay[0]
    const p = requestId ? state.pending.get(requestId) : undefined
    if (p && !ports.write(replayFrame(p, ports))) {
      if (ports.canReplay()) {
        const timer = ports.later(() => flushReplay(state, ports), REPLAY_RETRY_MS)
        ports.unrefTimer?.(timer)
      }
      return
    }
    state.replay.shift()
  }
  ports.changed()
}

/** A lost transport fails every call; 4400 and 1009 make every pending command status-only. */
export function disconnectRequests(state: PendingState, code: number): void {
  state.replay.length = 0
  for (const [id, call] of state.calls) {
    clearTimeout(call.timer)
    call.resolve(callFailure(id, 'Connection closed.'))
  }
  state.calls.clear()
  if (code === 4400 || code === 1009) for (const p of state.pending.values()) p.statusOnly = true
}

export function closeRequests(state: PendingState): void {
  disconnectRequests(state, 0)
  for (const [requestId, p] of state.pending) p.resolve({ requestId, status: 'unknown' })
  state.pending.clear()
  for (const timer of state.expiries.values()) clearTimeout(timer)
  state.expiries.clear()
}

function expireCommand(state: PendingState, ports: RequestPorts, requestId: string): void {
  state.expiries.delete(requestId)
  const p = state.pending.get(requestId)
  if (!p) return
  p.statusOnly = true
  ports.write({ type: 'receipt-status', requestId })
  p.resolve({ requestId, status: 'unknown' })
}

/** Called only after the command was written; it stays pending until a receipt or close. */
export function trackCommand(
  state: PendingState,
  ports: RequestPorts,
  frame: Command,
  resolve: (result: CommandResult) => void,
): void {
  const requestId = frame.requestId
  state.pending.set(requestId, { frame, at: ports.now(), statusOnly: false, resolve })
  state.expiries.set(
    requestId,
    setTimeout(() => expireCommand(state, ports, requestId), UNCERTAIN_AFTER_MS),
  )
}

/** Terminal operations settle silently: their receipts would flood the log. */
export function settleReceipt(state: PendingState, ports: RequestPorts, receipt: Receipt): void {
  const p = state.pending.get(receipt.requestId)
  p?.resolve(receipt)
  state.pending.delete(receipt.requestId)
  clearTimeout(state.expiries.get(receipt.requestId))
  state.expiries.delete(receipt.requestId)
  const op = p?.frame.op.type
  if (op && !op.startsWith('terminal.'))
    ports.log('hosts', 'receipt', {
      hostId: ports.hostId,
      requestId: receipt.requestId,
      status: receipt.status,
    })
}

export function settleResult(state: PendingState, result: Result): void {
  const call = state.calls.get(result.id)
  if (!call) return
  clearTimeout(call.timer)
  state.calls.delete(result.id)
  call.resolve(result)
}

export function startCall(
  state: PendingState,
  ports: RequestPorts,
  id: string,
  ready: boolean,
  method: string,
  params: unknown,
  trace: string,
): Promise<Result> {
  if (state.calls.size >= HOST_LIMITS.pendingCommandsPerConnection || !ready)
    return Promise.resolve(callFailure(id, 'Connection unavailable.'))
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.calls.delete(id)
      resolve(callFailure(id, 'Query timed out.'))
    }, CALL_TIMEOUT_MS)
    state.calls.set(id, { resolve, timer })
    if (!ports.write({ type: 'call', id, method, params, trace })) ports.transportFailed()
  })
}

/** Binds one connection's pending state to its ports. Only replay-safe commands retry. */
export function createRequests(ports: RequestPorts) {
  const state = createPendingState()
  return {
    disconnect: (code: number) => disconnectRequests(state, code),
    close: () => closeRequests(state),
    prepareReplay: () => {
      state.replay.push(...state.pending.keys())
    },
    flushReplay: () => flushReplay(state, ports),
    replaying: () => state.replay.length > 0,
    full: () => state.pending.size >= HOST_LIMITS.pendingCommandsPerConnection,
    track: (frame: Command, resolve: (result: CommandResult) => void) =>
      trackCommand(state, ports, frame, resolve),
    receipt: (receipt: Receipt) => settleReceipt(state, ports, receipt),
    result: (result: Result) => settleResult(state, result),
    call: (id: string, ready: boolean, method: string, params: unknown, trace: string) =>
      startCall(state, ports, id, ready, method, params, trace),
  }
}
