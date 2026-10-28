import type { LaneMarksChange } from '@phosphor/shared/host-protocol-lane-marks'
import type { DeleteLaneOp } from '@phosphor/shared/host-protocol-repositories'
import type { HostAttachments } from '../../features/attachments'
import type { HostStore, StoredLane } from '../store'
import type { LaneAdmission } from './admission'
import { dispatch, publish } from './queue'
import { log, rejected, terminal, type ReceiptPorts } from './receipts'
import type { CommandState, Execution, Job, LaneCommandPorts, LaneQueue } from './state'

export type LanePorts = ReceiptPorts &
  Pick<LaneCommandPorts, 'publish' | 'summaryFor' | 'deleteLane' | 'resumeLane' | 'stopLane'> & {
    store: Pick<
      HostStore,
      'takeControl' | 'releaseControl' | 'markRead' | 'setLaneMarks' | 'getLane'
    >
    attachments?: Pick<HostAttachments, 'abort'>
  }
type LifecycleOp = 'lane.resume' | 'lane.stop'
/** A lane whose folder was removed outside Phosphor can only be deleted. */
export const LANE_FOLDER_MISSING =
  "This lane's folder no longer exists on the Host, so it cannot resume. Delete the lane to clear it."

/** Control, read state, deletion and lifecycle, after admission. Anything else is unsupported. */
export function executeLane(
  state: CommandState,
  ports: LanePorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
  allowed: () => boolean,
): Execution | void {
  const { op } = job.frame
  switch (op.type) {
    case 'control.take':
      return takeControl(state, ports, job, queue, admitted.laneId)
    case 'control.release':
      return releaseControl(state, ports, job, queue, admitted.laneId)
    case 'lane.markRead':
      markRead(state, ports, queue, admitted.laneId, op.upTo)
      break
    case 'lane.marks':
      setLaneMarks(state, ports, queue, admitted.laneId, op)
      break
    case 'lane.delete':
      return deleteLane(state, ports, job, queue, { admitted, op, allowed })
    case 'lane.resume':
    case 'lane.stop': {
      const execution = executeLifecycle(state, ports, job, queue, admitted, op.type)
      if (execution) return execution
      break
    }
    default:
      return rejected(state, ports, job, 'unsupported', true)
  }
  answerDone(state, ports, job, admitted.fence)
}

function answerDone(
  state: CommandState,
  ports: ReceiptPorts,
  job: Job,
  fence: number | undefined,
): void {
  const { requestId } = job.frame
  terminal(
    state,
    ports,
    job,
    { requestId, status: 'done', ...(fence === undefined ? {} : { fence }) },
    true,
  )
}

export function takeControl(
  state: CommandState,
  ports: LanePorts,
  job: Job,
  queue: LaneQueue,
  laneId: string,
): void {
  const { client, frame } = job
  ports.attachments?.abort(laneId)
  const control = ports.store.takeControl(laneId, { clientId: client.id, label: client.label })
  publish(state, ports, laneId, { kind: 'control', control }, queue)
  terminal(
    state,
    ports,
    job,
    { requestId: frame.requestId, status: 'done', fence: control.fence },
    true,
  )
}

export function releaseControl(
  state: CommandState,
  ports: LanePorts,
  job: Job,
  queue: LaneQueue,
  laneId: string,
): void {
  const { requestId } = job.frame
  const released = ports.store.releaseControl(laneId, job.client.id)
  if (!released.released)
    return terminal(
      state,
      ports,
      job,
      { requestId, status: 'rejected', code: 'not-controller', control: released.control },
      true,
    )
  ports.attachments?.abort(laneId)
  publish(state, ports, laneId, { kind: 'control', control: released.control }, queue)
  terminal(state, ports, job, { requestId, status: 'done', fence: released.control.fence }, true)
}

/** Unfenced: any reader may advance the read mark. The summary publication is best effort. */
export function markRead(
  state: CommandState,
  ports: LanePorts,
  queue: LaneQueue,
  laneId: string,
  upTo: number,
): void {
  ports.store.markRead(laneId, upTo)
  const summary = ports.summaryFor(laneId)
  if (summary) publish(state, ports, laneId, { kind: 'summary', summary }, queue)
}

/** Unfenced, on live and stopped lanes: any client that may control lanes pins and marks them. */
export function setLaneMarks(
  state: CommandState,
  ports: LanePorts,
  queue: LaneQueue,
  laneId: string,
  change: LaneMarksChange,
): void {
  ports.store.setLaneMarks(laneId, change)
  const summary = ports.summaryFor(laneId)
  if (summary) publish(state, ports, laneId, { kind: 'summary', summary }, queue)
}

/** The destructive authority check: live capabilities, the same controller and the admitted fence. */
export function deletionAllowed(
  ports: { store: Pick<HostStore, 'getLane'> },
  job: Job,
  admitted: LaneAdmission,
  allowed: () => boolean,
): () => boolean {
  return () =>
    allowed() &&
    ports.store.getLane(admitted.laneId)?.control.controller?.clientId === job.client.id &&
    ports.store.getLane(admitted.laneId)?.control.fence === admitted.fence
}

export function deleteLane(
  state: CommandState,
  ports: LanePorts,
  job: Job,
  queue: LaneQueue,
  input: { admitted: LaneAdmission; op: DeleteLaneOp; allowed: () => boolean },
): Execution | void {
  const { requestId } = job.frame
  if (!ports.deleteLane) return rejected(state, ports, job, 'unsupported', true)
  const remove = ports.deleteLane
  const deletable = deletionAllowed(ports, job, input.admitted, input.allowed)
  const completion = dispatch(state, ports, job, queue, () => remove(input.op, deletable)).then(
    (result) => {
      if (!result.answered)
        return terminal(state, ports, job, { requestId, status: 'unknown' }, true)
      if (!result.value.ok) return rejected(state, ports, job, result.value.code, true)
      terminal(state, ports, job, { requestId, status: 'done', data: result.value.data }, true)
    },
  )
  return { completion, detached: false }
}

/** Resume a stopped lane or stop a live one. Already there is a no-op, answered done. */
export function executeLifecycle(
  state: CommandState,
  ports: LanePorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
  opType: LifecycleOp,
): Execution | undefined {
  const resume = opType === 'lane.resume'
  if (resume ? admitted.sessionId !== null : admitted.sessionId === null) return undefined
  const { requestId } = job.frame
  const completion = dispatch(state, ports, job, queue, () =>
    lifecycle(ports, { laneId: admitted.laneId, requestId, opType, lane: admitted.lane }),
  ).then((result) => {
    if (!result.answered)
      return terminal(state, ports, job, { requestId, status: 'unknown' }, true, result.reason)
    terminal(
      state,
      ports,
      job,
      result.value
        ? { requestId, status: 'failed', error: result.value }
        : { requestId, status: 'done', fence: admitted.fence },
      true,
    )
  })
  return { completion, detached: false }
}

function lifecycleFailure(resume: boolean, code: unknown): string {
  if (resume)
    return code === 'lane-folder-missing' ? LANE_FOLDER_MISSING : 'the lane could not start'
  return code === 'first-prompt-required'
    ? 'Send a first message before stopping this lane.'
    : 'the lane could not stop'
}

/** Null on success, else the fixed failure text. Only a token-shaped error code is logged. */
export async function lifecycle(
  ports: Pick<LaneCommandPorts, 'resumeLane' | 'stopLane' | 'log'>,
  input: { laneId: string; requestId: string; opType: LifecycleOp; lane: StoredLane },
) {
  const { laneId, requestId, opType, lane } = input
  const resume = opType === 'lane.resume'
  try {
    if (resume) await ports.resumeLane(lane)
    else await ports.stopLane(laneId)
    return null
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code))
      log(ports, 'lane.command_error', { laneId, requestId, op: opType, code })
    return { code: 'internal', message: lifecycleFailure(resume, code) } as const
  }
}
