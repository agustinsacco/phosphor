import { parseRepositoryOp } from '@phosphor/shared/host-protocol-repositories'
import { parseRoutineOp } from '@phosphor/shared/host-protocol-routines'
import { parseTerminalOp } from '@phosphor/shared/host-protocol-terminals'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { TerminalForbidden, type HostTerminals } from '../../terminals/service'
import { dispatch } from './queue'
import { rejected, terminal, type ReceiptPorts } from './receipts'
import type { CommandState, Execution, Job, LaneCommandPorts, LaneQueue } from './state'

/**
 * A handler either did not match the op, or handled it: answered it synchronously
 * (no execution) or started an execution the queue tracks.
 */
export type Routed = { handled: false } | { handled: true; execution?: Execution }
export const NOT_MATCHED: Routed = { handled: false }
export const handled = (execution?: Execution): Routed => ({ handled: true, execution })

export type MachinePorts = ReceiptPorts &
  Pick<LaneCommandPorts, 'repositories' | 'routines' | 'providerLogins'> & {
    terminals?: Pick<HostTerminals, 'machineOp'>
  }

/** Repository management. Runs before any owed lane control is republished. */
export function executeRepository(
  state: CommandState,
  ports: MachinePorts,
  job: Job,
  queue: LaneQueue,
  allowed: () => boolean,
): Routed {
  const repositoryOp = parseRepositoryOp(job.frame.op)
  if (!repositoryOp) return NOT_MATCHED
  const { requestId, laneId, fence } = job.frame
  if (!ports.repositories || laneId !== undefined || fence !== undefined) {
    rejected(state, ports, job, 'bad-request', true)
    return handled()
  }
  const repositories = ports.repositories
  const completion = dispatch(state, ports, job, queue, () =>
    repositories.execute(repositoryOp, allowed),
  ).then((result) => {
    if (!result.answered) return terminal(state, ports, job, { requestId, status: 'unknown' }, true)
    if (!result.value.ok) return rejected(state, ports, job, result.value.code, true)
    terminal(state, ports, job, { requestId, status: 'done', data: result.value.data }, true)
  })
  return handled({ completion, detached: false })
}

/** Routine commands, given the capabilities read when the queued op started. */
export function executeRoutine(
  state: CommandState,
  ports: MachinePorts,
  job: Job,
  queue: LaneQueue,
  caps: readonly HostCapability[],
): Routed {
  const routine = parseRoutineOp(job.frame.op)
  if (!routine) return NOT_MATCHED
  const { requestId, laneId, fence } = job.frame
  if (!ports.routines) {
    rejected(state, ports, job, 'unsupported', true)
    return handled()
  }
  if (laneId !== undefined || fence !== undefined) {
    rejected(state, ports, job, 'bad-request', true)
    return handled()
  }
  const completion = dispatch(state, ports, job, queue, () =>
    ports.routines?.execute(routine, requestId, caps),
  ).then((result) => {
    if (!result.answered) return terminal(state, ports, job, { requestId, status: 'unknown' }, true)
    terminal(state, ports, job, { requestId, status: 'done', data: result.value }, true)
  })
  return handled({ completion, detached: false })
}

/** Provider login and terminal ops without a lane: both act on a machine terminal. */
export function executeMachineTerminal(
  state: CommandState,
  ports: MachinePorts,
  job: Job,
  queue: LaneQueue,
  allowed: () => boolean,
): Routed {
  const { client, frame } = job
  const { requestId, laneId, op } = frame
  const terminalOp = parseTerminalOp(op)
  if (op.type !== 'provider.login' && !(terminalOp && laneId === undefined)) return NOT_MATCHED
  if (frame.fence !== undefined || laneId !== undefined) {
    rejected(state, ports, job, 'bad-request', true)
    return handled()
  }
  const completion = dispatch(state, ports, job, queue, async () => {
    // Recheck at dispatch; a missing port or refusal answers unknown, not forbidden.
    if (!allowed()) throw new TerminalForbidden('forbidden')
    if (op.type === 'provider.login') {
      if (!ports.providerLogins) throw new Error('unavailable')
      return ports.providerLogins.execute(op, client.id, allowed)
    }
    if (!ports.terminals || !terminalOp) throw new Error('unavailable')
    return ports.terminals.machineOp(client.id, terminalOp)
  }).then((result) => {
    if (!result.answered) return terminal(state, ports, job, { requestId, status: 'unknown' }, true)
    terminal(state, ports, job, { requestId, status: 'done', data: result.value }, true)
  })
  return handled({ completion, detached: false })
}
