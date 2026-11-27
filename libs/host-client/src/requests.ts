import { isBrainSurfaceOp } from '@phosphor/shared/host-brain'
import {
  HOST_CALL_TIMEOUT_MS,
  HOST_LIMITS,
  type ClientFrame,
  type HostFrame,
  type Receipt,
} from '@phosphor/shared/host-protocol'

export type NotSent = {
  requestId: string
  status: 'not-sent'
  reason: 'too-large' | 'too-many-pending' | 'not-connected' | 'closed'
}
export type CommandResult = Receipt | NotSent
type Command = Extract<ClientFrame, { type: 'command' }>
type Result = Extract<HostFrame, { type: 'result' }>
type Pending = {
  frame: Command
  at: number
  statusOnly: boolean
  resolve: (result: CommandResult) => void
}

const COMMAND_WAIT_MS = 60_000
// Leave time for admission and receipt delivery beyond the Host's 120 s window.
const PI_START_WAIT_MS = 180_000
const privateCommand = (frame: Command) =>
  frame.op.type === 'ops.run' && isBrainSurfaceOp(frame.op.op)

function commandWait(frame: Command): number {
  return frame.op.type === 'lane.create' ||
    frame.op.type === 'set_model' ||
    frame.op.type === 'lane.resume'
    ? PI_START_WAIT_MS
    : COMMAND_WAIT_MS
}

function queryFailure(id: string, message: string): Result {
  return { type: 'result', id, ok: false, error: { code: 'internal', message } }
}

function isPublicReceipt(item?: Pending) {
  return item !== undefined && !privateCommand(item.frame)
}

/** Receipts outlive a transport; read calls do not. Only replay-safe commands retry. */
interface RequestPorts {
  now: () => number
  write: (frame: ClientFrame) => boolean
  later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  canReplay: () => boolean
  unrefTimer?: (timer: ReturnType<typeof setTimeout>) => void
  changed: () => void
  transportFailed: () => void
}

function replayFlusher(ports: RequestPorts, pending: Map<string, Pending>, replay: string[]) {
  function flushReplay() {
    while (replay.length) {
      const requestId = replay[0]
      const p = requestId ? pending.get(requestId) : undefined
      if (
        p &&
        !ports.write(
          p.statusOnly || ports.now() - p.at >= COMMAND_WAIT_MS
            ? { type: 'receipt-status', requestId: p.frame.requestId }
            : p.frame,
        )
      ) {
        if (ports.canReplay()) {
          const timer = ports.later(flushReplay, 250)
          ports.unrefTimer?.(timer)
        }
        return
      }
      replay.shift()
    }
    ports.changed()
  }
  return flushReplay
}

export function createRequests(ports: RequestPorts) {
  const pending = new Map<string, Pending>()
  const expiries = new Map<string, ReturnType<typeof setTimeout>>()
  const calls = new Map<
    string,
    {
      resolve: (result: Result) => void
      timer: ReturnType<typeof setTimeout>
      privateData: boolean
    }
  >()
  const replay: string[] = []
  function disconnect(code: number) {
    replay.length = 0
    for (const [id, call] of calls) {
      clearTimeout(call.timer)
      call.resolve(queryFailure(id, 'Connection closed.'))
    }
    calls.clear()
    // Brain commands deliberately have no replay or persisted private receipt.
    for (const [requestId, item] of pending) {
      if (!privateCommand(item.frame)) continue
      clearTimeout(expiries.get(requestId))
      expiries.delete(requestId)
      pending.delete(requestId)
      item.resolve({ requestId, status: 'unknown' })
    }
    if (code === 4400 || code === 1009) for (const p of pending.values()) p.statusOnly = true
  }
  return {
    disconnect,
    close() {
      disconnect(0)
      for (const [requestId, p] of pending) p.resolve({ requestId, status: 'unknown' })
      pending.clear()
      for (const timer of expiries.values()) clearTimeout(timer)
      expiries.clear()
    },
    prepareReplay() {
      replay.push(...pending.keys())
    },
    flushReplay: replayFlusher(ports, pending, replay),
    replaying: () => replay.length > 0,
    full: () => pending.size >= HOST_LIMITS.pendingCommandsPerConnection,
    track(frame: Command, resolve: (result: CommandResult) => void) {
      const requestId = frame.requestId
      pending.set(requestId, { frame, at: ports.now(), statusOnly: false, resolve })
      expiries.set(
        requestId,
        setTimeout(() => {
          expiries.delete(requestId)
          const p = pending.get(requestId)
          if (!p) return
          p.statusOnly = true
          ports.write({ type: 'receipt-status', requestId })
          p.resolve({ requestId, status: 'unknown' })
        }, commandWait(frame)),
      )
    },
    receipt(receipt: Receipt) {
      const op = pending.get(receipt.requestId)?.frame.op.type
      pending.get(receipt.requestId)?.resolve(receipt)
      pending.delete(receipt.requestId)
      clearTimeout(expiries.get(receipt.requestId))
      expiries.delete(receipt.requestId)
      return op
    },
    publicResult: (id: string) => calls.get(id)?.privateData === false,
    publicReceipt: (id: string) => isPublicReceipt(pending.get(id)),
    result(result: Result) {
      const call = calls.get(result.id)
      if (!call) return
      clearTimeout(call.timer)
      calls.delete(result.id)
      call.resolve(result)
    },
    call(
      id: string,
      ready: boolean,
      method: string,
      params: unknown,
      trace: string,
      timeoutMs = HOST_CALL_TIMEOUT_MS,
    ): Promise<Result> {
      if (calls.size >= HOST_LIMITS.pendingCommandsPerConnection || !ready)
        return Promise.resolve(queryFailure(id, 'Connection unavailable.'))
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          calls.delete(id)
          resolve(queryFailure(id, 'Query timed out.'))
        }, timeoutMs)
        calls.set(id, {
          resolve,
          timer,
          privateData:
            method === 'ops.run' &&
            !!params &&
            typeof params === 'object' &&
            'op' in params &&
            isBrainSurfaceOp(params.op),
        })
        if (!ports.write({ type: 'call', id, method, params, trace })) ports.transportFailed()
      })
    },
  }
}
