import {
  HOST_LIMITS,
  type ClientFrame,
  type HostFrame,
  type LaneCreatePhase,
  type Receipt,
} from '@phosphor/shared/host-protocol'
import type { LaneStartView } from '@phosphor/shared/ipc'

export type NotSent = {
  requestId: string
  status: 'not-sent'
  reason: 'too-large' | 'too-many-pending' | 'not-connected' | 'closed'
}
export type CommandResult = Receipt | NotSent
type Command = Extract<ClientFrame, { type: 'command' }>
type Result = Extract<HostFrame, { type: 'result' }>
type Pending = { frame: Command; at: number; statusOnly: boolean }

function failedCall(id: string, message: string): Result {
  return { type: 'result', id, ok: false, error: { code: 'internal', message } }
}

/** Unsettled `lane.create` commands, without their prompt, for the hosts snapshot. */
function laneStarts(
  pending: ReadonlyMap<string, Pending>,
  phases: ReadonlyMap<string, LaneCreatePhase>,
): LaneStartView[] {
  return [...pending].flatMap(([requestId, { frame, statusOnly }]) => {
    const op = frame.op
    if (op.type !== 'lane.create' || statusOnly) return []
    const phase = phases.get(requestId)
    return [
      {
        repositoryId: op.repositoryId,
        branch: op.worktree?.branch ?? null,
        ...(phase ? { phase } : {}),
      },
    ]
  })
}

/** Receipts outlive a transport; read calls do not. Only replay-safe commands retry. */
export function createRequests(ports: {
  now: () => number
  write: (frame: ClientFrame) => boolean
  later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  canReplay: () => boolean
  unrefTimer?: (timer: ReturnType<typeof setTimeout>) => void
  changed: () => void
  transportFailed: () => void
}) {
  const pending = new Map<string, Pending & { resolve: (result: CommandResult) => void }>()
  const phases = new Map<string, LaneCreatePhase>()
  const expiries = new Map<string, ReturnType<typeof setTimeout>>()
  const calls = new Map<
    string,
    { resolve: (result: Result) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const replay: string[] = []
  function flushReplay() {
    while (replay.length) {
      const requestId = replay[0]
      const p = requestId ? pending.get(requestId) : undefined
      if (
        p &&
        !ports.write(
          p.statusOnly || ports.now() - p.at >= 60000
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
  function disconnect(code: number) {
    replay.length = 0
    for (const [id, call] of calls) {
      clearTimeout(call.timer)
      call.resolve(failedCall(id, 'Connection closed.'))
    }
    calls.clear()
    if (code === 4400 || code === 1009) for (const p of pending.values()) p.statusOnly = true
  }
  return {
    disconnect,
    close() {
      disconnect(0)
      for (const [requestId, p] of pending) p.resolve({ requestId, status: 'unknown' })
      pending.clear()
      phases.clear()
      for (const timer of expiries.values()) clearTimeout(timer)
      expiries.clear()
    },
    prepareReplay() {
      replay.push(...pending.keys())
    },
    flushReplay,
    replaying: () => replay.length > 0,
    laneStarts: () => laneStarts(pending, phases),
    full: () => pending.size >= HOST_LIMITS.pendingCommandsPerConnection,
    track(frame: Command, resolve: (result: CommandResult) => void) {
      const requestId = frame.requestId
      pending.set(requestId, { frame, at: ports.now(), statusOnly: false, resolve })
      if (frame.op.type === 'lane.create') ports.changed()
      expiries.set(
        requestId,
        setTimeout(() => {
          expiries.delete(requestId)
          const p = pending.get(requestId)
          if (!p) return
          p.statusOnly = true
          ports.write({ type: 'receipt-status', requestId })
          p.resolve({ requestId, status: 'unknown' })
          phases.delete(requestId)
          if (p.frame.op.type === 'lane.create') ports.changed()
        }, 60000),
      )
    },
    /** A `pending` receipt only moves a creation's phase; it never settles the command. */
    receipt(receipt: Receipt) {
      const p = pending.get(receipt.requestId)
      const op = p?.frame.op.type
      if (receipt.status === 'pending') {
        if (op !== 'lane.create' || !receipt.phase || p?.statusOnly) return undefined
        phases.set(receipt.requestId, receipt.phase)
        return void ports.changed()
      }
      p?.resolve(receipt)
      pending.delete(receipt.requestId)
      if (phases.delete(receipt.requestId) || op === 'lane.create') ports.changed()
      clearTimeout(expiries.get(receipt.requestId))
      expiries.delete(receipt.requestId)
      return op
    },
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
    ): Promise<Result> {
      if (calls.size >= HOST_LIMITS.pendingCommandsPerConnection || !ready)
        return Promise.resolve(failedCall(id, 'Connection unavailable.'))
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          calls.delete(id)
          resolve(failedCall(id, 'Query timed out.'))
        }, 30000)
        calls.set(id, { resolve, timer })
        if (!ports.write({ type: 'call', id, method, params, trace })) ports.transportFailed()
      })
    },
  }
}
