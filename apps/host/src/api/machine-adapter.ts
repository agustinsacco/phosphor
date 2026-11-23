import { OPS_RUN, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { sendFrame, type FrameLinkFactory } from './adapter'
import type { AuthenticatedFrame } from './connection'

/** Ops only a surface may run: confirm answers, policy and undo. A machine never reaches them. */
const SURFACE_ONLY_OPS: ReadonlySet<string> = new Set(
  OP_CATALOG.filter((spec) => spec.surfaceOnly === true).map((spec) => spec.name),
)
const SURFACE_ONLY: OpsRunResult = {
  status: 'denied',
  code: 'forbidden',
  text: 'Only you can do this, in Phosphor.',
}

/** The op an `ops.run` frame names, before the ops adapter parses it; null for any other frame. */
function opsRunOp(frame: AuthenticatedFrame): string | null {
  if (frame.type === 'command' && frame.op.type === OPS_RUN) return frame.op.op
  if (frame.type !== 'call' || frame.method !== OPS_RUN) return null
  const params: unknown = frame.params
  return params !== null &&
    typeof params === 'object' &&
    'op' in params &&
    typeof params.op === 'string'
    ? params.op
    : ''
}

/**
 * Another machine's agent reaches this Host only through `ops.run`. This link
 * sits ahead of the ops adapter: it refuses surface-only ops in band, lets every
 * other `ops.run` and the client-scoped `receipt-status` through, and refuses
 * everything else (subscriptions, lane commands and calls, terminal input)
 * before the lane adapter. The confirm store refusing a machine stays the
 * second line, not the only one.
 */
export function createMachineAdapter(): FrameLinkFactory {
  return (connection) => {
    if (connection.principal?.kind !== 'grant-machine') return null
    const { socket } = connection
    return {
      handle(frame) {
        const op = opsRunOp(frame)
        if (op !== null && !SURFACE_ONLY_OPS.has(op)) return false
        if (frame.type === 'receipt-status') return false
        if (frame.type === 'call' && op !== null)
          sendFrame(socket, { type: 'result', id: frame.id, ok: true, data: SURFACE_ONLY })
        else if (frame.type === 'command' && op !== null)
          sendFrame(socket, {
            type: 'receipt',
            receipt: { requestId: frame.requestId, status: 'done', data: SURFACE_ONLY },
          })
        else if (frame.type === 'subscribe')
          sendFrame(socket, { type: 'subscribe-failed', id: frame.id, code: 'forbidden' })
        else if (frame.type === 'command')
          sendFrame(socket, {
            type: 'receipt',
            receipt: { requestId: frame.requestId, status: 'rejected', code: 'forbidden' },
          })
        else if (frame.type === 'call')
          sendFrame(socket, {
            type: 'result',
            id: frame.id,
            ok: false,
            error: { code: 'forbidden', message: 'forbidden' },
          })
        else if (frame.type === 'terminal.input')
          sendFrame(socket, {
            type: 'terminal.ack',
            terminalId: frame.terminalId,
            seq: frame.seq,
            accepted: false,
          })
        return true
      },
    }
  }
}
