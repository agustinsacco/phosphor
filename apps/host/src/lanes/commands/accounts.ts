import type { LaneAdmission } from './admission'
import { dispatch } from './queue'
import { rejected, terminal, type ReceiptPorts } from './receipts'
import { handled, NOT_MATCHED, type Routed } from './routing'
import type { CommandState, Job, LaneCommandPorts, LaneQueue } from './state'

type AccountPorts = ReceiptPorts & Pick<LaneCommandPorts, 'store' | 'moveClaudeAccount'>

/** Account moves remain fenced while stopping, binding and resuming the lane. */
export function executeAccountMove(
  state: CommandState,
  ports: AccountPorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
  authorized: () => boolean,
): Routed {
  const { op, requestId } = job.frame
  if (op.type !== 'claude.account') return NOT_MATCHED
  const move = ports.moveClaudeAccount
  if (!move) {
    rejected(state, ports, job, 'unsupported', true)
    return handled()
  }
  const allowed = () => {
    const lane = ports.store.getLane(admitted.laneId)
    return authorized() &&
      lane?.control.controller?.clientId === job.client.id &&
      lane.control.fence === admitted.fence
  }
  const completion = dispatch(state, ports, job, queue, () =>
    move(admitted.laneId, op.accountId, allowed).then(() => true, () => false),
  ).then((result) => {
    if (!result.answered)
      return terminal(state, ports, job, { requestId, status: 'unknown' }, true)
    terminal(state, ports, job, result.value
      ? { requestId, status: 'done', fence: admitted.fence }
      : {
          requestId,
          status: 'failed',
          error: {
            code: 'internal',
            message: 'Account change not completed. Check the lane before retrying; it may be stopped.',
          },
        }, true)
  })
  return handled({ completion, detached: false })
}
