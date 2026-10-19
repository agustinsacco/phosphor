import { parseProviderLoginOp, type ProviderLoginOp } from '@shared/host-protocol-providers'
import { parseMachineTask, type MachineTaskOp } from '@shared/machine-settings'
import { parseTerminalCreated, TERMINAL_LIMITS } from '@shared/host-protocol-terminals'
import {
  createTerminalEntry,
  type TerminalConnection,
  type TerminalLane,
  type TerminalAdmission,
  type RemoteTerminalEntry,
} from './terminal-state'
import { REMOTE_UNAVAILABLE } from './lane-ops'

interface ProgramState {
  connection?: (hostId: string) => TerminalConnection | undefined
  control(lane: TerminalLane): boolean
  entries: Map<string, RemoteTerminalEntry>
  admissions: Set<TerminalAdmission>
  flushKill(entry: RemoteTerminalEntry): Promise<void>
}

function machine(state: ProgramState, hostId: string): TerminalLane {
  const c = state.connection?.(hostId)
  if (!c || c.snapshot().state !== 'ready') throw new Error(REMOTE_UNAVAILABLE)
  return {
    hostId,
    laneId: '',
    connection: c,
    machine: true,
    current: () => state.connection?.(hostId) === c,
  }
}

async function machineProgram(
  state: ProgramState,
  windowId: number,
  hostId: string,
  op: ProviderLoginOp | MachineTaskOp | null,
) {
  const lane = machine(state, hostId)
  const c = lane.connection
  const incarnation = c.incarnation()
  const needsConfiguration =
    op?.type === 'machine.task' ||
    (op?.type === 'provider.login' && (op.configure || op.accountId || op.addAccount))
  if (
    !op ||
    (needsConfiguration && !c.snapshot().capabilities.includes('machine.configure')) ||
    !state.control(lane) ||
    !c.snapshot().capabilities.includes('terminal') ||
    state.entries.size + state.admissions.size >= TERMINAL_LIMITS.perHost * 32
  )
    throw new Error(REMOTE_UNAVAILABLE)
  lane.configuration = !!needsConfiguration
  const admission = { windowId, cancelled: false }
  state.admissions.add(admission)
  let result
  try {
    result = await c.send(op)
  } finally {
    state.admissions.delete(admission)
  }
  const created = result.status === 'done' ? parseTerminalCreated(result.data) : null
  if (!created) throw new Error('Sign-in not confirmed. Refresh before trying again.')
  const unavailable =
    (needsConfiguration && !c.snapshot().capabilities.includes('machine.configure')) ||
    !lane.current() ||
    c.snapshot().state !== 'ready' ||
    !state.control(lane) ||
    !c.snapshot().capabilities.includes('terminal') ||
    c.incarnation().runtimeEpoch !== incarnation.runtimeEpoch ||
    admission.cancelled
  const entry = createTerminalEntry({
    windowId,
    sessionId: '',
    workspace: '',
    lane,
    terminalId: created.terminalId,
    epoch: incarnation.runtimeEpoch,
    generation: incarnation.generation,
  })
  state.entries.set(entry.id, entry)
  if (unavailable) {
    entry.killing = true
    await state.flushKill(entry)
    throw new Error(REMOTE_UNAVAILABLE)
  }
  return { ptyId: entry.id }
}

/** Private programs share the terminal owner's admission, cleanup and connection identities. */
export function createMachinePrograms(state: ProgramState) {
  return {
    async signIn(
      windowId: number,
      hostId: string,
      provider: string,
      account?: Pick<ProviderLoginOp, 'accountId' | 'addAccount' | 'configure'>,
    ) {
      return machineProgram(
        state,
        windowId,
        hostId,
        parseProviderLoginOp({ type: 'provider.login', provider, ...account }),
      )
    },
    task: async (windowId: number, hostId: string, op: MachineTaskOp) =>
      machineProgram(state, windowId, hostId, parseMachineTask(op)),
  }
}
