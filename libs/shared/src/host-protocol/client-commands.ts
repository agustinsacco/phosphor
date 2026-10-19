/** Command and call frames: their ids, lane and fence rules, and the reply each refusal names. */
import { isControlTrace, isUuid } from '../control-api'
import { BAD_REQUEST_OP_TYPES, parseLaneOp } from './client-ops'
import type { ClientFrameParse } from './frames'
import type { LaneOp } from './operations'
import { frameId, integer, member, record, text } from './primitives'

/** Routine, provider login and repository ops never carry a lane id or fence. */
function laneless(op: LaneOp): boolean {
  return (
    op.type.startsWith('routine.') ||
    op.type === 'provider.login' ||
    op.type === 'machine.task' ||
    op.type.startsWith('host.repositories.')
  )
}

/** An invalid request id is refused bare; any later refusal names a receipt for that id. */
export function parseCommandFrame(v: Record<string, unknown>): ClientFrameParse {
  if (!isUuid(v.requestId)) return { ok: false, reason: 'frame' }
  const operation = parseLaneOp(v.op)
  if (
    !operation ||
    (laneless(operation) && (v.laneId !== undefined || v.fence !== undefined)) ||
    (operation.type === 'claude.account' && (v.laneId === undefined || v.fence === undefined)) ||
    (v.laneId !== undefined && !isUuid(v.laneId)) ||
    (v.fence !== undefined && !integer(v.fence, 1)) ||
    (v.trace !== undefined && !isControlTrace(v.trace))
  ) {
    return {
      ok: false,
      reason: 'command',
      reply: {
        kind: 'receipt',
        requestId: v.requestId,
        code:
          record(v.op) && typeof v.op.type === 'string' && !member(v.op.type, BAD_REQUEST_OP_TYPES)
            ? 'unsupported'
            : 'bad-request',
      },
    }
  }
  return {
    ok: true,
    frame: {
      type: 'command',
      requestId: v.requestId,
      op: operation,
      ...(v.laneId !== undefined ? { laneId: v.laneId } : {}),
      ...(v.fence !== undefined ? { fence: v.fence } : {}),
      ...(v.trace !== undefined ? { trace: v.trace } : {}),
    },
  }
}

/** An invalid call id is refused bare; any later refusal names a result for that id. */
export function parseCallFrame(v: Record<string, unknown>): ClientFrameParse {
  if (!frameId(v.id)) return { ok: false, reason: 'frame' }
  if (
    !text(v.method, 64) ||
    !/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){1,2}$/.test(v.method) ||
    (v.trace !== undefined && !isControlTrace(v.trace))
  )
    return {
      ok: false,
      reason: 'call',
      reply: { kind: 'result', id: v.id, code: 'bad-request' },
    }
  return {
    ok: true,
    frame: {
      type: 'call',
      id: v.id,
      method: v.method,
      ...(v.params !== undefined ? { params: v.params } : {}),
      ...(v.trace !== undefined ? { trace: v.trace } : {}),
    },
  }
}
