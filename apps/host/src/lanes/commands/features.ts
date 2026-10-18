import { parseAttachmentOp } from '@phosphor/shared/host-protocol-attachments'
import { parseTerminalOp } from '@phosphor/shared/host-protocol-terminals'
import { parseFileWriteOp } from '@phosphor/shared/host-protocol-writes'
import type { HostAttachments } from '../../features/attachments'
import { TerminalForbidden, type HostTerminals } from '../../terminals/service'
import type { LaneAdmission } from './admission'
import { handled, NOT_MATCHED, type Routed } from './machine'
import { dispatch } from './queue'
import { rejected, terminal, type ReceiptPorts } from './receipts'
import type { CommandState, Job, LaneCommandPorts, LaneQueue } from './state'

export type FeaturePorts = ReceiptPorts &
  Pick<LaneCommandPorts, 'writes'> & {
    terminals?: Pick<HostTerminals, 'execute'>
    attachments?: Pick<HostAttachments, 'execute'>
  }

/** A lane PTY op. The terminal service rechecks the live grant after its awaits. */
export function executeLaneTerminal(
  state: CommandState,
  ports: FeaturePorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
  allowed: () => boolean,
): Routed {
  const terminalOp = parseTerminalOp(job.frame.op)
  if (!terminalOp) return NOT_MATCHED
  const { requestId } = job.frame
  const terminals = ports.terminals
  if (!terminals) {
    rejected(state, ports, job, 'unsupported', true)
    return handled()
  }
  const completion = dispatch(state, ports, job, queue, async () => {
    try {
      return { data: await terminals.execute(admitted.laneId, terminalOp, allowed) }
    } catch (error) {
      if (error instanceof TerminalForbidden) return { forbidden: true }
      throw error
    }
  }).then((result) => {
    if (result.answered && result.value.forbidden)
      return rejected(state, ports, job, 'forbidden', true)
    terminal(
      state,
      ports,
      job,
      result.answered
        ? { requestId, status: 'done', data: result.value.data, fence: admitted.fence }
        : { requestId, status: 'unknown' },
      true,
    )
  })
  return handled({ completion, detached: false })
}

/** An upload step, owned by the client at the admitted fence. */
export function executeAttachment(
  state: CommandState,
  ports: FeaturePorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
): Routed {
  const attachment = parseAttachmentOp(job.frame.op)
  if (!attachment) return NOT_MATCHED
  const { requestId } = job.frame
  const attachments = ports.attachments
  const fence = admitted.fence
  if (!attachments || fence === undefined) {
    rejected(state, ports, job, 'unsupported', true)
    return handled()
  }
  const owner = { laneId: admitted.laneId, clientId: job.client.id, fence }
  const completion = dispatch(state, ports, job, queue, () =>
    attachments.execute(owner, attachment),
  ).then((result) => {
    if (!result.answered)
      return terminal(state, ports, job, { requestId, status: 'unknown' }, true, result.reason)
    terminal(
      state,
      ports,
      job,
      result.value.ok
        ? { requestId, status: 'done', data: result.value.data, fence }
        : { requestId, status: 'rejected', code: result.value.code },
      true,
    )
  })
  return handled({ completion, detached: false })
}

/** A files.* mutation in the lane's folder. */
export function executeWrite(
  state: CommandState,
  ports: FeaturePorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
): Routed {
  const { requestId, op } = job.frame
  if (!op.type.startsWith('files.')) return NOT_MATCHED
  const write = parseFileWriteOp(op)
  const writes = ports.writes
  if (!write || !writes) {
    rejected(state, ports, job, 'unsupported', true)
    return handled()
  }
  const completion = dispatch(state, ports, job, queue, () =>
    writes.execute(admitted.laneId, write),
  ).then((result) => {
    if (!result.answered)
      return terminal(state, ports, job, { requestId, status: 'unknown' }, true, result.reason)
    terminal(
      state,
      ports,
      job,
      result.value.ok
        ? { requestId, status: 'done', data: result.value.data, fence: admitted.fence }
        : { requestId, status: 'rejected', code: result.value.code },
      true,
    )
  })
  return handled({ completion, detached: false })
}

/** Lane features after admission, in routing order: terminal, attachment, files. */
export function executeLaneFeature(
  state: CommandState,
  ports: FeaturePorts,
  job: Job,
  queue: LaneQueue,
  admitted: LaneAdmission,
  allowed: () => boolean,
): Routed {
  const laneTerminal = executeLaneTerminal(state, ports, job, queue, admitted, allowed)
  if (laneTerminal.handled) return laneTerminal
  const attachment = executeAttachment(state, ports, job, queue, admitted)
  if (attachment.handled) return attachment
  return executeWrite(state, ports, job, queue, admitted)
}
