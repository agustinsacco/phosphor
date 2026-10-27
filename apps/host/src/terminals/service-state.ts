import {
  parseTerminalList,
  type TerminalFrame,
  type TerminalSummary,
} from '@phosphor/shared/host-protocol-terminals'
import type { TerminalRun } from '../machine/terminal'
import type { FeatureContext } from '../features/feature'
import type { HostPty, HostPtyModule } from './native'

/** A forced stop has no observed code; the numeric wire uses -1, never a clean 0. */
export const FORCED_EXIT_CODE = -1

export type Entry = TerminalSummary & {
  login?: {
    owner: string
    configuration?: boolean
    deferExit?: boolean
    authorized?: () => boolean
    nativeExitCode?: number
    disconnectedAt?: number
    finish: (result: TerminalRun) => void
  }
  /** A machine shell: no lane, cwd is the Host account's home, never persisted. */
  machine?: true
  pty?: HostPty
  /** The code kill() reported, which a login's tombstone repeats. */
  exitCode?: number
  seq: number
  inputSeq: number
  window: number
  bytes: number
  chunks: { seq: number; data: string; bytes: number }[]
  outputBytes: number
  listeners: Set<(frame: TerminalFrame) => void>
}
export type TerminalOptions = {
  native: HostPtyModule
  context: FeatureContext
  env: Record<string, string>
  epoch: string
  now?: () => number
  shell?: () => string
  home?: () => string
  load(): unknown
  save(rows: TerminalSummary[]): void
}
export interface TerminalState {
  options: TerminalOptions
  entries: Map<string, Entry>
  closed: boolean
  timer?: ReturnType<typeof setInterval>
  now: () => number
}
export function createEntry(row: TerminalSummary): Entry {
  return {
    ...row,
    seq: 0,
    inputSeq: 0,
    window: 0,
    bytes: 0,
    chunks: [],
    outputBytes: 0,
    listeners: new Set(),
  }
}
export function createTerminalState(options: TerminalOptions): TerminalState {
  const restored = parseTerminalList(options.load())
  if (!restored) throw new Error('Invalid terminal state')
  const entries = new Map<string, Entry>()
  for (const row of restored)
    entries.set(
      row.terminalId,
      createEntry({ ...row, status: row.status === 'running' ? 'interrupted' : row.status }),
    )
  return { options, entries, closed: false, now: options.now ?? Date.now }
}
