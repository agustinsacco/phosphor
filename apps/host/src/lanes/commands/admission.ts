import { UNFENCED_OPS, type RejectCode } from '@phosphor/shared/host-protocol'
import type { RpcCommand } from '@phosphor/shared/rpc'
import type { HostAttachments } from '../../features/attachments'
import { commandRefusal } from '../../session/runtime'
import type { HostStore, StoredLane } from '../store'
import { handled, NOT_MATCHED, type Routed } from './routing'
import { publish } from './queue'
import { controlFailure, rejected, terminal, type ReceiptPorts } from './receipts'
import { toPiCommand } from './rpc'
import type { CommandState, Job, LaneCommandPorts, LaneQueue, Terminal } from './state'

/** A lane op that passed every refusal and, unless unfenced, the controller fence. */
export interface LaneAdmission {
  laneId: string
  lane: StoredLane
  sessionId: string | null
  piCommand: RpcCommand | null
  /** The fence the op was admitted at; undefined for an unfenced op. */
  fence: number | undefined
}
export type AdmissionPorts = ReceiptPorts &
  Pick<LaneCommandPorts, 'publish' | 'sessionFor' | 'openDialogs' | 'refusal'> & {
    store: Pick<HostStore, 'getLane' | 'admit'>
    attachments?: Pick<HostAttachments, 'abort'>
  }

/** Republish control a failed publication still owes before this queue's next lane op. */
export function republishControl(
  state: CommandState,
  ports: AdmissionPorts,
  job: Job,
  queue: LaneQueue,
): Routed {
  const { laneId } = job.frame
  if (!queue.controlUnpublished || laneId === undefined) return NOT_MATCHED
  const control = ports.store.getLane(laneId)?.control
  if (!control) {
    queue.controlUnpublished = false
    rejected(state, ports, job, 'unknown-lane', true)
    return handled()
  }
  if (publish(state, ports, laneId, { kind: 'control', control }, queue)) return NOT_MATCHED
  controlFailure(state, ports, job)
  return handled()
}

/** Refusals checked before the fence, so none of them acquires an empty lane. */
export function laneRefusal(
  ports: Pick<AdmissionPorts, 'openDialogs' | 'refusal'>,
  job: Job,
  lane: StoredLane,
  sessionId: string | null,
  piCommand: RpcCommand | null,
): Terminal | null {
  const { client, frame } = job
  const { requestId, op } = frame
  const refuse = (code: RejectCode): Terminal => ({ requestId, status: 'rejected', code })
  if ((piCommand || op.type === 'extension_ui_response') && sessionId === null)
    return refuse('lane-stopped')
  if (piCommand && (ports.refusal ?? commandRefusal)(piCommand) !== null)
    return refuse('unsupported')
  if (
    op.type === 'extension_ui_response' &&
    !ports.openDialogs(lane.laneId).includes(op.response.id)
  )
    return refuse('bad-request')
  // Release never acquires an empty lane just to release it again.
  if (op.type === 'control.release' && lane.control.controller === null)
    return { requestId, status: 'rejected', code: 'not-controller', control: lane.control }
  if (
    op.type === 'lane.delete' &&
    (op.laneId !== lane.laneId || lane.control.controller?.clientId !== client.id)
  )
    return refuse('not-controller')
  return null
}

/** Admit a fenced op. A moved fence aborts uploads and publishes control before dispatch. */
export function admitFence(
  state: CommandState,
  ports: AdmissionPorts,
  job: Job,
  queue: LaneQueue,
  lane: StoredLane,
): { admitted: true; fence: number | undefined } | { admitted: false } {
  const { client, frame } = job
  const { requestId, op } = frame
  const laneId = lane.laneId
  if (UNFENCED_OPS.includes(op.type)) return { admitted: true, fence: undefined }
  if (frame.fence === undefined) {
    rejected(state, ports, job, 'bad-request', true)
    return { admitted: false }
  }
  const admission = ports.store.admit(
    laneId,
    { clientId: client.id, label: client.label },
    frame.fence,
  )
  if (!admission.admitted) {
    const { code, control } = admission
    terminal(state, ports, job, { requestId, status: 'rejected', code, control }, true)
    return { admitted: false }
  }
  const moved = admission.control.fence !== lane.control.fence
  if (moved) ports.attachments?.abort(laneId)
  if (
    moved &&
    !publish(state, ports, laneId, { kind: 'control', control: admission.control }, queue)
  ) {
    controlFailure(state, ports, job)
    return { admitted: false }
  }
  return { admitted: true, fence: admission.control.fence }
}

/** The lane, its refusals, then its fence. Null means the job was already answered. */
export function admitLane(
  state: CommandState,
  ports: AdmissionPorts,
  job: Job,
  queue: LaneQueue,
): LaneAdmission | null {
  const { requestId, laneId, op } = job.frame
  const lane = laneId === undefined ? null : ports.store.getLane(laneId)
  if (!lane || lane.removedAt !== null || laneId === undefined) {
    rejected(state, ports, job, 'unknown-lane', true)
    return null
  }
  const sessionId = ports.sessionFor(laneId)
  const piCommand = toPiCommand(op, requestId)
  const refusal = laneRefusal(ports, job, lane, sessionId, piCommand)
  if (refusal) {
    terminal(state, ports, job, refusal, true)
    return null
  }
  const fenced = admitFence(state, ports, job, queue, lane)
  if (!fenced.admitted) return null
  return { laneId, lane, sessionId, piCommand, fence: fenced.fence }
}
