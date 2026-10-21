import {
  parseProviderLoginOp,
  type ProviderLoginOp,
} from '@phosphor/shared/host-protocol-providers'
import { parseMachineTask, type MachineTaskOp } from '@phosphor/shared/machine-settings'
import {
  parseTerminalCreated,
  parseTerminalList,
  parseTerminalOp,
  TERMINAL_LIMITS,
} from '@phosphor/shared/host-protocol-terminals'
import {
  createTerminalEntry,
  type TerminalConnection,
  type TerminalLane,
  type TerminalAdmission,
  type RemoteTerminalEntry,
} from './terminal-state'
import { REMOTE_UNAVAILABLE } from '../lane-ops'

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

/** The Host's shared shell in its home: reuse the running one, so every device sees it. */
async function machineShell(
  state: ProgramState,
  windowId: number,
  hostId: string,
  cols: number,
  rows: number,
) {
  const lane = { ...machine(state, hostId), shell: true }
  const c = lane.connection
  if (!c.snapshot().machineShell) throw new Error('Update this Host to open a terminal.')
  const op = parseTerminalOp({ type: 'terminal.create', cols, rows })
  if (!op) throw new Error('Invalid terminal request.')
  const usable = () =>
    lane.current() &&
    c.snapshot().state === 'ready' &&
    c.snapshot().capabilities.includes('terminal') &&
    state.control(lane)
  if (!usable() || state.entries.size + state.admissions.size >= TERMINAL_LIMITS.perHost * 32)
    throw new Error(REMOTE_UNAVAILABLE)
  const incarnation = c.incarnation()
  const admission = { windowId, cancelled: false }
  state.admissions.add(admission)
  let terminalId: string | undefined
  try {
    const listed = await c.call('terminal.list', {})
    const list = listed.ok ? parseTerminalList(listed.data) : null
    if (!list) throw new Error('Could not list machine shells. Retry before starting one.')
    if (!usable() || admission.cancelled || c.incarnation().generation !== incarnation.generation)
      throw new Error(REMOTE_UNAVAILABLE)
    terminalId = list.find((t) => t.laneId === '' && t.status === 'running')?.terminalId
    if (!terminalId) {
      const result = await c.send(op)
      terminalId =
        result.status === 'done' ? parseTerminalCreated(result.data)?.terminalId : undefined
    }
  } finally {
    state.admissions.delete(admission)
  }
  if (!terminalId) throw new Error('Terminal creation not confirmed.')
  if (!usable() || admission.cancelled || c.incarnation().generation !== incarnation.generation)
    throw new Error(REMOTE_UNAVAILABLE)
  const existing = [...state.entries.values()].find(
    (e) => e.lane.connection === c && e.terminalId === terminalId && e.windowId === windowId,
  )
  if (existing && !existing.killing) return { ptyId: existing.id }
  const entry = createTerminalEntry({
    windowId,
    sessionId: '',
    workspace: '',
    lane,
    terminalId,
    epoch: incarnation.runtimeEpoch,
    generation: incarnation.generation,
  })
  state.entries.set(entry.id, entry)
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
    shell: (windowId: number, hostId: string, cols: number, rows: number) =>
      machineShell(state, windowId, hostId, cols, rows),
  }
}
