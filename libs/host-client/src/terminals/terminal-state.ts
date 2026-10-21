import type { createHostConnection } from '../connection'

export type TerminalConnection = ReturnType<typeof createHostConnection>
export interface TerminalLane {
  machine?: boolean
  /** A shared machine shell: closing a window detaches from it instead of killing it. */
  shell?: boolean
  configuration?: boolean
  hostId: string
  laneId: string
  connection: TerminalConnection
  current: () => boolean
}
export interface TerminalAdmission {
  windowId: number
  cancelled: boolean
}
export interface RemoteTerminalEntry {
  id: string
  windowId: number
  sessionId: string
  workspace: string
  lane: TerminalLane
  terminalId: string
  epoch: string
  generation: number
  inputSeq: number
  cursor?: { epoch: string; seq: number }
  synchronized: boolean
  resetVersion: number
  killing?: boolean
  killBusy?: boolean
  ended: boolean
  busy: boolean
  pending: { data: string; resolve: () => void; reject: (error: Error) => void }[]
  pendingBytes: number
  dropVersion: number
  watch?: ReturnType<TerminalConnection['watchTerminal']>
}

/** Both lane shells and private programs use the same fresh sequencing state. */
export function createTerminalEntry(
  identity: Pick<
    RemoteTerminalEntry,
    'windowId' | 'sessionId' | 'workspace' | 'lane' | 'terminalId' | 'epoch' | 'generation'
  >,
): RemoteTerminalEntry {
  return {
    id: `remote-pty-${crypto.randomUUID()}`,
    ...identity,
    inputSeq: 0,
    synchronized: false,
    resetVersion: 0,
    ended: false,
    busy: false,
    pending: [],
    pendingBytes: 0,
    dropVersion: 0,
  }
}
