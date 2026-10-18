import type { LaneOp } from '@phosphor/shared/host-protocol'
import type { RpcCommand } from '@phosphor/shared/rpc'
import type { LaneAdmission } from './admission'
import { handled, NOT_MATCHED, type Routed } from './routing'
import { dispatch, publish } from './queue'
import { receiptMessage, rejected, terminal, type ReceiptPorts } from './receipts'
import type { CommandState, Execution, Job, LaneCommandPorts, LaneQueue } from './state'

export type RpcPorts = ReceiptPorts & Pick<LaneCommandPorts, 'runtime' | 'publish'>
type DialogResponse = Extract<LaneOp, { type: 'extension_ui_response' }>['response']
/** A live lane's pi session and the fence the op was admitted at. */
type PiTarget = { laneId: string; sessionId: string; fence: number | undefined }

/** The Host-owned allowlist: only these lane ops reach pi, under the request id. */
export function toPiCommand(op: LaneOp, id: string): RpcCommand | null {
  switch (op.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
    case 'abort':
    case 'abort_retry':
    case 'set_model':
    case 'set_thinking_level':
    case 'compact':
    case 'set_session_name':
      return { ...op, id }
    default:
      return null
  }
}

/** Pi commands and dialog answers. Both are detached: the lane queue moves on at dispatch. */
export function executeRpc(
  state: CommandState,
  ports: RpcPorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
): Routed {
  const { op } = job.frame
  const { laneId, piCommand, sessionId, fence } = admitted
  if (piCommand && sessionId !== null)
    return handled(sendPiCommand(state, ports, job, queue, { laneId, sessionId, fence }, piCommand))
  if (op.type !== 'extension_ui_response') return NOT_MATCHED
  if (sessionId === null) {
    rejected(state, ports, job, 'lane-stopped', true)
    return handled()
  }
  return handled(answerDialog(state, ports, job, queue, { laneId, sessionId, fence }, op.response))
}

function sendPiCommand(
  state: CommandState,
  ports: RpcPorts,
  job: Job,
  queue: LaneQueue,
  target: PiTarget,
  piCommand: RpcCommand,
): Execution {
  const { requestId } = job.frame
  const completion = dispatch(state, ports, job, queue, () =>
    ports.runtime.command(target.sessionId, piCommand),
  ).then((result) => {
    if (!result.answered)
      return terminal(state, ports, job, { requestId, status: 'unknown' }, true, result.reason)
    const response = result.value
    terminal(
      state,
      ports,
      job,
      response.success
        ? { requestId, status: 'done', data: response.data, fence: target.fence }
        : {
            requestId,
            status: 'failed',
            error: { code: 'pi-error', message: receiptMessage(response.error) },
          },
      true,
    )
  })
  return { completion, detached: true }
}

/** Publishes dialog-resolved only after pi accepted the answer, then answers done. */
function answerDialog(
  state: CommandState,
  ports: RpcPorts,
  job: Job,
  queue: LaneQueue,
  target: PiTarget,
  response: DialogResponse,
): Execution {
  const { requestId } = job.frame
  const completion = dispatch(state, ports, job, queue, () =>
    ports.runtime.extensionUiResponse(target.sessionId, response),
  ).then((result) => {
    if (!result.answered)
      return terminal(state, ports, job, { requestId, status: 'unknown' }, true, result.reason)
    publish(state, ports, target.laneId, { kind: 'dialog-resolved', dialogId: response.id }, queue)
    terminal(state, ports, job, { requestId, status: 'done', fence: target.fence }, true)
  })
  return { completion, detached: true }
}
