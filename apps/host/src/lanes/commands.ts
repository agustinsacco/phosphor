import { parseRepositoryOp } from '@phosphor/shared/host-protocol-repositories'
import { parseProviderLoginOp } from '@phosphor/shared/host-protocol-providers'
import { parseAttachmentOp } from '@phosphor/shared/host-protocol-attachments'
import { parseTerminalOp } from '@phosphor/shared/host-protocol-terminals'
import { TerminalForbidden } from '../terminals/service'
import { parseFileWriteOp } from '@phosphor/shared/host-protocol-writes'
import { UNFENCED_OPS, type LaneEvent, type RejectCode } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { parseRoutineOp, routineRequiresControl } from '@phosphor/shared/host-protocol-routines'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { commandRefusal } from '../session/runtime'
import type { StoredLane } from './store'
import { executeCreate } from './commands/create'
import { executeMachineTerminal, executeRepository, executeRoutine } from './commands/machine'
import * as queueing from './commands/queue'
import * as receipts from './commands/receipts'
import {
  createCommandState,
  type Execution,
  type Job,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
  type LaneQueue,
  type Terminal,
} from './commands/state'

export {
  COMMAND_CLOSE_GRACE_MS,
  LANE_QUEUE_LIMIT,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
} from './commands/state'
export { receiptMessage } from './commands/receipts'

/** Parsed frames and authenticated grant clients enter here, never raw pi RPC. */
export function createLaneCommands(ports: LaneCommandPorts, options: { queueLimit?: number } = {}) {
  const { store, runtime } = ports
  const state = createCommandState(options.queueLimit)
  const refusal = ports.refusal ?? commandRefusal
  // Bound to this service's state and ports while execute still lives in the factory.
  const log = (message: string, data: unknown) => receipts.log(ports, message, data)
  const terminal = (job: Job, receipt: Terminal, recorded: boolean, reason?: string) =>
    receipts.terminal(state, ports, job, receipt, recorded, reason)
  const rejected = (job: Job, code: RejectCode, recorded: boolean) =>
    receipts.rejected(state, ports, job, code, recorded)
  const controlFailure = (job: Job) => receipts.controlFailure(state, ports, job)
  const publish = (laneId: string, event: LaneEvent, queue: LaneQueue) =>
    queueing.publish(state, ports, laneId, event, queue)
  const dispatch = <T>(job: Job, queue: LaneQueue, run: () => Promise<T> | T) =>
    queueing.dispatch(state, ports, job, queue, run)
  /** Every capability an op needs, at admission and again when a queued op starts. */
  function capabilityFor(op: LaneCommandFrame['op']): readonly HostCapability[] {
    if (op.type === 'lane.delete' || parseRepositoryOp(op))
      return ['workspaces.write', 'sessions.control']
    if (parseAttachmentOp(op)) return ['workspaces.write', 'sessions.control']
    const routine = parseRoutineOp(op)
    if (routine)
      return routineRequiresControl(routine) ? ['routines', 'sessions.control'] : ['routines']
    if (parseProviderLoginOp(op) || parseTerminalOp(op)) return ['terminal', 'sessions.control']
    const write = op.type.startsWith('files.') ? ports.writes?.capabilityFor(op.type) : null
    return write ? [write, 'sessions.control'] : ['sessions.control']
  }
  function execute(job: Job, queue: LaneQueue): Execution | void {
    const { frame, client } = job
    const { requestId, laneId, op } = frame
    // A grant can be renewed, or its connection closed, while the op was queued.
    const holds = (caps: readonly HostCapability[]) =>
      capabilityFor(op).every((cap) => caps.includes(cap))
    const allowed = () => holds(client.currentCaps?.() ?? client.caps)
    const caps = client.currentCaps?.() ?? client.caps
    if (!holds(caps)) return rejected(job, 'forbidden', true)
    if (op.type.startsWith('files.') && !ports.writes?.capabilityFor(op.type))
      return rejected(job, 'forbidden', true)
    const repository = executeRepository(state, ports, job, queue, allowed)
    if (repository.handled) return repository.execution
    const terminalOp = parseTerminalOp(op)
    if (queue.controlUnpublished && laneId !== undefined) {
      const control = store.getLane(laneId)?.control
      if (!control) {
        queue.controlUnpublished = false
        return rejected(job, 'unknown-lane', true)
      }
      if (!publish(laneId, { kind: 'control', control }, queue)) return controlFailure(job)
    }
    const routine = executeRoutine(state, ports, job, queue, caps)
    if (routine.handled) return routine.execution
    const machineTerminal = executeMachineTerminal(state, ports, job, queue, allowed)
    if (machineTerminal.handled) return machineTerminal.execution
    if (op.type === 'lane.create') return executeCreate(state, ports, job, queue, { op, execute })
    const lane = laneId === undefined ? null : store.getLane(laneId)
    if (!lane || lane.removedAt !== null || laneId === undefined)
      return rejected(job, 'unknown-lane', true)
    const sessionId = ports.sessionFor(laneId)
    const piCommand = toPiCommand(op, requestId)
    if ((piCommand || op.type === 'extension_ui_response') && sessionId === null)
      return rejected(job, 'lane-stopped', true)
    if (piCommand && refusal(piCommand) !== null) return rejected(job, 'unsupported', true)
    if (op.type === 'extension_ui_response' && !ports.openDialogs(laneId).includes(op.response.id))
      return rejected(job, 'bad-request', true)
    // Release never acquires an empty lane just to release it again.
    if (op.type === 'control.release' && lane.control.controller === null)
      return terminal(
        job,
        { requestId, status: 'rejected', code: 'not-controller', control: lane.control },
        true,
      )
    if (
      op.type === 'lane.delete' &&
      (op.laneId !== laneId || lane.control.controller?.clientId !== client.id)
    )
      return rejected(job, 'not-controller', true)
    let admittedFence: number | undefined
    if (!UNFENCED_OPS.includes(op.type)) {
      if (frame.fence === undefined) return rejected(job, 'bad-request', true)
      const admission = store.admit(
        laneId,
        { clientId: client.id, label: client.label },
        frame.fence,
      )
      if (!admission.admitted) {
        return terminal(
          job,
          { requestId, status: 'rejected', code: admission.code, control: admission.control },
          true,
        )
      }
      if (admission.control.fence !== lane.control.fence) ports.attachments?.abort(laneId)
      admittedFence = admission.control.fence
      if (
        admission.control.fence !== lane.control.fence &&
        !publish(laneId, { kind: 'control', control: admission.control }, queue)
      )
        return controlFailure(job)
    }
    if (terminalOp) {
      const terminals = ports.terminals
      if (!terminals) return rejected(job, 'unsupported', true)
      const completion = dispatch(job, queue, async () => {
        try {
          return { data: await terminals.execute(laneId, terminalOp, allowed) }
        } catch (error) {
          if (error instanceof TerminalForbidden) return { forbidden: true }
          throw error
        }
      }).then((result) => {
        if (result.answered && result.value.forbidden) return rejected(job, 'forbidden', true)
        terminal(
          job,
          result.answered
            ? { requestId, status: 'done', data: result.value.data, fence: admittedFence }
            : { requestId, status: 'unknown' },
          true,
        )
      })
      return { completion, detached: false }
    }
    const attachment = parseAttachmentOp(op)
    if (attachment) {
      const attachments = ports.attachments
      if (!attachments || admittedFence === undefined) return rejected(job, 'unsupported', true)
      const fence = admittedFence
      const completion = dispatch(job, queue, () =>
        attachments.execute({ laneId, clientId: client.id, fence }, attachment),
      ).then((result) => {
        if (!result.answered)
          return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
        terminal(
          job,
          result.value.ok
            ? { requestId, status: 'done', data: result.value.data, fence }
            : { requestId, status: 'rejected', code: result.value.code },
          true,
        )
      })
      return { completion, detached: false }
    }
    if (op.type.startsWith('files.')) {
      const write = parseFileWriteOp(op)
      if (!write || !ports.writes) return rejected(job, 'unsupported', true)
      const writes = ports.writes
      const completion = dispatch(job, queue, () => writes.execute(laneId, write)).then(
        (result) => {
          if (!result.answered)
            return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
          terminal(
            job,
            result.value.ok
              ? { requestId, status: 'done', data: result.value.data, fence: admittedFence }
              : { requestId, status: 'rejected', code: result.value.code },
            true,
          )
        },
      )
      return { completion, detached: false }
    }
    if (piCommand && sessionId !== null) {
      const completion = dispatch(job, queue, () => runtime.command(sessionId, piCommand)).then(
        (result) => {
          if (!result.answered)
            return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
          const response = result.value
          terminal(
            job,
            response.success
              ? { requestId, status: 'done', data: response.data, fence: admittedFence }
              : {
                  requestId,
                  status: 'failed',
                  error: { code: 'pi-error', message: receipts.receiptMessage(response.error) },
                },
            true,
          )
        },
      )
      return { completion, detached: true }
    }
    switch (op.type) {
      case 'extension_ui_response': {
        if (sessionId === null) return rejected(job, 'lane-stopped', true)
        const completion = dispatch(job, queue, () =>
          runtime.extensionUiResponse(sessionId, op.response),
        ).then((result) => {
          if (!result.answered)
            return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
          publish(laneId, { kind: 'dialog-resolved', dialogId: op.response.id }, queue)
          terminal(job, { requestId, status: 'done', fence: admittedFence }, true)
        })
        return { completion, detached: true }
      }
      case 'control.take': {
        ports.attachments?.abort(laneId)
        const control = store.takeControl(laneId, { clientId: client.id, label: client.label })
        publish(laneId, { kind: 'control', control }, queue)
        return terminal(job, { requestId, status: 'done', fence: control.fence }, true)
      }
      case 'control.release': {
        const released = store.releaseControl(laneId, client.id)
        if (!released.released)
          return terminal(
            job,
            { requestId, status: 'rejected', code: 'not-controller', control: released.control },
            true,
          )
        ports.attachments?.abort(laneId)
        publish(laneId, { kind: 'control', control: released.control }, queue)
        return terminal(job, { requestId, status: 'done', fence: released.control.fence }, true)
      }
      case 'lane.markRead': {
        store.markRead(laneId, op.upTo)
        const summary = ports.summaryFor(laneId)
        if (summary) publish(laneId, { kind: 'summary', summary }, queue)
        break
      }
      case 'lane.delete': {
        if (!ports.deleteLane) return rejected(job, 'unsupported', true)
        const deleteLane = ports.deleteLane
        const deletable = () =>
          allowed() &&
          store.getLane(laneId)?.control.controller?.clientId === client.id &&
          store.getLane(laneId)?.control.fence === admittedFence
        const completion = dispatch(job, queue, () => deleteLane(op, deletable)).then((result) => {
          if (!result.answered) return terminal(job, { requestId, status: 'unknown' }, true)
          if (!result.value.ok) return rejected(job, result.value.code, true)
          terminal(job, { requestId, status: 'done', data: result.value.data }, true)
        })
        return { completion, detached: false }
      }
      case 'lane.resume':
      case 'lane.stop': {
        const resume = op.type === 'lane.resume'
        if (resume ? sessionId !== null : sessionId === null) break
        const completion = dispatch(job, queue, () =>
          lifecycle(laneId, requestId, op.type, lane),
        ).then((result) => {
          if (!result.answered)
            return terminal(job, { requestId, status: 'unknown' }, true, result.reason)
          terminal(
            job,
            result.value
              ? { requestId, status: 'failed', error: result.value }
              : { requestId, status: 'done', fence: admittedFence },
            true,
          )
        })
        return { completion, detached: false }
      }
      default:
        return rejected(job, 'unsupported', true)
    }
    terminal(
      job,
      {
        requestId,
        status: 'done',
        ...(admittedFence === undefined ? {} : { fence: admittedFence }),
      },
      true,
    )
  }
  async function lifecycle(
    laneId: string,
    requestId: string,
    opType: 'lane.resume' | 'lane.stop',
    lane: StoredLane,
  ) {
    const resume = opType === 'lane.resume'
    try {
      if (resume) await ports.resumeLane(lane)
      else await ports.stopLane(laneId)
      return null
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code))
        log('lane.command_error', { laneId, requestId, op: opType, code })
      return {
        code: 'internal',
        message:
          !resume && code === 'first-prompt-required'
            ? 'Send a first message before stopping this lane.'
            : resume
              ? 'the lane could not start'
              : 'the lane could not stop',
      } as const
    }
  }
  const router = { capabilityFor, execute }
  return {
    capabilityFor,
    submit: (client: LaneCommandClient, frame: LaneCommandFrame): Promise<void> =>
      queueing.submit(state, ports, router, client, frame),
    status: (clientId: string, requestId: string, connectionId?: string): void =>
      queueing.status(state, ports, clientId, requestId, connectionId),
    close: (): Promise<void> => queueing.close(state),
  }
}

function toPiCommand(op: LaneCommandFrame['op'], id: string): RpcCommand | null {
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
