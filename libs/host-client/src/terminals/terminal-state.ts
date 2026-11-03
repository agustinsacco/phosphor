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
  exitReported: boolean
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
    exitReported: false,
    busy: false,
    pending: [],
    pendingBytes: 0,
    dropVersion: 0,
  }
}

/**
 * Report an entry's end once. Only the Host's exit frame carries a real code; a reset with an
 * ended status, or a lane that went away, reports -1 (unknown) and never success.
 */
export function reportExit(
  e: RemoteTerminalEntry,
  emit: (windowId: number, channel: string, code: number) => void,
  code: number,
) {
  if (e.exitReported) return
  e.ended = e.exitReported = true
  emit(e.windowId, `pty:exit:${e.id}`, code)
}
