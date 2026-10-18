import { parseAttachmentOp } from '@phosphor/shared/host-protocol-attachments'
import { parseProviderLoginOp } from '@phosphor/shared/host-protocol-providers'
import { parseRepositoryOp } from '@phosphor/shared/host-protocol-repositories'
import { parseRoutineOp, routineRequiresControl } from '@phosphor/shared/host-protocol-routines'
import { parseTerminalOp } from '@phosphor/shared/host-protocol-terminals'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { admitLane, republishControl } from './commands/admission'
import { executeAccountMove } from './commands/accounts'
import { executeCreate } from './commands/create'
import { executeLaneFeature } from './commands/features'
import { executeLane } from './commands/lane'
import { executeMachineTerminal, executeRepository, executeRoutine } from './commands/machine'
import { close, status, submit } from './commands/queue'
import { rejected } from './commands/receipts'
import { executeRpc } from './commands/rpc'
import {
  createCommandState,
  type CommandRouter,
  type CommandState,
  type Execution,
  type Job,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
  type LaneQueue,
} from './commands/state'

export {
  COMMAND_CLOSE_GRACE_MS,
  LANE_QUEUE_LIMIT,
  type LaneCommandClient,
  type LaneCommandFrame,
  type LaneCommandPorts,
} from './commands/state'
export { receiptMessage } from './commands/receipts'

/** Every capability an op needs, at admission and again when a queued op starts. */
function capabilityFor(
  ports: Pick<LaneCommandPorts, 'writes'>,
  op: LaneCommandFrame['op'],
): readonly HostCapability[] {
  if (op.type === 'claude.account') return ['machine.configure', 'sessions.control']
  if (
    op.type === 'machine.task' ||
    (op.type === 'provider.login' && (op.configure || op.accountId || op.addAccount))
  )
    return ['machine.configure', 'terminal', 'sessions.control']
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

/**
 * Route one queued job. The capability gate comes first, read from the client's
 * current grant; then machine families, owed control, creation and lane admission.
 */
function execute(
  state: CommandState,
  ports: LaneCommandPorts,
  job: Job,
  queue: LaneQueue,
): Execution | void {
  const { client, frame } = job
  const { op } = frame
  // A grant can be renewed, or its connection closed, while the op was queued.
  const holds = (caps: readonly HostCapability[]) =>
    capabilityFor(ports, op).every((cap) => caps.includes(cap))
  const allowed = () => holds(client.currentCaps?.() ?? client.caps)
  const caps = client.currentCaps?.() ?? client.caps
  if (!holds(caps)) return rejected(state, ports, job, 'forbidden', true)
  if (op.type.startsWith('files.') && !ports.writes?.capabilityFor(op.type))
    return rejected(state, ports, job, 'forbidden', true)
  const repository = executeRepository(state, ports, job, queue, allowed)
  if (repository.handled) return repository.execution
  const owed = republishControl(state, ports, job, queue)
  if (owed.handled) return owed.execution
  const routine = executeRoutine(state, ports, job, queue, caps)
  if (routine.handled) return routine.execution
  const machineTerminal = executeMachineTerminal(state, ports, job, queue, allowed)
  if (machineTerminal.handled) return machineTerminal.execution
  if (op.type === 'lane.create')
    return executeCreate(state, ports, job, queue, {
      op,
      execute: (next, nextQueue) => execute(state, ports, next, nextQueue),
    })
  const admitted = admitLane(state, ports, job, queue)
  if (!admitted) return
  const account = executeAccountMove(state, ports, job, queue, admitted, allowed)
  if (account.handled) return account.execution
  const feature = executeLaneFeature(state, ports, job, queue, admitted, allowed)
  if (feature.handled) return feature.execution
  const rpc = executeRpc(state, ports, job, queue, admitted)
  if (rpc.handled) return rpc.execution
  return executeLane(state, ports, job, queue, admitted, allowed)
}

/** Parsed frames and authenticated grant clients enter here, never raw pi RPC. */
export function createLaneCommands(ports: LaneCommandPorts, options: { queueLimit?: number } = {}) {
  const state = createCommandState(options.queueLimit)
  const router: CommandRouter = {
    capabilityFor: (op) => capabilityFor(ports, op),
    execute: (job, queue) => execute(state, ports, job, queue),
  }
  return {
    capabilityFor: router.capabilityFor,
    submit: (client: LaneCommandClient, frame: LaneCommandFrame): Promise<void> =>
      submit(state, ports, router, client, frame),
    status: (clientId: string, requestId: string, connectionId?: string): void =>
      status(state, ports, clientId, requestId, connectionId),
    close: (): Promise<void> => close(state),
  }
}
