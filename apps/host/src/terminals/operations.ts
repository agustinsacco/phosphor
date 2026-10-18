import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { isAbsolute } from 'node:path'
import {
  TERMINAL_LIMITS as L,
  parseTerminalOp,
  parseTerminalInput,
  parseTerminalListParams,
  type TerminalOp,
  type TerminalInput,
} from '@phosphor/shared/host-protocol-terminals'
import type { HostFeature } from '../features/feature'
import { laneRoot } from '../features/files'
import { createEntry, type Entry, type TerminalState } from './service-state'
import { persist, alive, kill, reap, close } from './lifecycle'
import { emit, output } from './output'

export class TerminalForbidden extends Error {}

function exited(state: TerminalState, entry: Entry, exitCode: number) {
  if (entry.status !== 'running') return
  entry.pty = undefined
  entry.status = 'exited'
  emit(entry, {
    type: 'terminal.exit',
    id: 'live',
    terminalId: entry.terminalId,
    epoch: state.options.epoch,
    seq: ++entry.seq,
    exitCode,
  })
  try {
    persist(state)
  } catch {
    close(state)
  }
}
function createTerminal(
  state: TerminalState,
  laneId: string,
  op: Extract<TerminalOp, { type: 'terminal.create' }>,
  cwd: string,
) {
  const { options, entries } = state
  // laneRoot awaits I/O: recheck limits after it, before any spawn.
  reap(state)
  if (!alive(state, laneId)) throw new Error('unknown-lane')
  if (
    entries.size >= L.perHost ||
    [...entries.values()].filter((e) => e.laneId === laneId).length >= L.perLane
  )
    throw new Error('too-many-requests')
  const shell = (options.shell ?? (() => userInfo().shell || '/bin/sh'))()
  if (!isAbsolute(shell) || shell.includes('\0')) throw new Error('unavailable')
  const entry = createEntry({ terminalId: randomUUID(), laneId, status: 'running' })
  entries.set(entry.terminalId, entry)
  // Record identity before spawn. A crash can only restore an interrupted terminal.
  try {
    persist(state)
    entry.pty = options.native.spawn(shell, ['-l'], {
      cwd,
      cols: op.cols,
      rows: op.rows,
      name: 'xterm-256color',
      env: { ...options.env, TERM: 'xterm-256color' },
    })
    entry.pty.onData((data) => output(state, entry, data))
    entry.pty.onExit(({ exitCode }) => exited(state, entry, exitCode))
  } catch {
    kill(state, entry)
    entries.delete(entry.terminalId)
    persist(state)
    throw new Error('unavailable')
  }
  return { terminalId: entry.terminalId }
}
export async function execute(
  state: TerminalState,
  laneId: string,
  input: TerminalOp,
  authorized: () => boolean = () => true,
): Promise<unknown> {
  const { options, entries } = state
  if (!authorized()) throw new TerminalForbidden('forbidden')
  if (state.closed) throw new Error('unavailable')
  const op = parseTerminalOp(input)
  if (!op) throw new Error('bad-request')
  reap(state)
  const cwd = await laneRoot(options.context, laneId)
  if (!authorized()) throw new TerminalForbidden('forbidden')
  if (state.closed) throw new Error('unavailable')
  if (op.type === 'terminal.create') return createTerminal(state, laneId, op, cwd)
  const entry = entries.get(op.terminalId)
  if (!entry || entry.laneId !== laneId) throw new Error('bad-request')
  if (op.type === 'terminal.resize') {
    if (!entry.pty) throw new Error('unavailable')
    entry.pty.resize(op.cols, op.rows)
  } else {
    kill(state, entry)
    entries.delete(entry.terminalId)
    entry.listeners.clear()
    persist(state)
  }
  return null
}
export function input(
  state: TerminalState,
  clientId: string,
  raw: TerminalInput,
  configuration = false,
): boolean {
  const { entries, options, now } = state
  if (state.closed) return false
  const frame = parseTerminalInput(raw)
  if (!frame) return false
  const entry = entries.get(frame.terminalId)
  if (
    !entry ||
    (entry.login?.configuration && (!configuration || entry.login.authorized?.() === false)) ||
    (!entry.login && !alive(state, entry.laneId)) ||
    !entry.pty
  )
    return false
  const lane = entry.login ? null : options.context.store.getLane(entry.laneId)
  if (
    (entry.login
      ? entry.login.owner !== clientId
      : lane?.control.controller?.clientId !== clientId) ||
    frame.seq !== entry.inputSeq + 1
  )
    return false
  const time = now()
  if (time - entry.window >= 1000) {
    entry.window = time
    entry.bytes = 0
  }
  const bytes = Buffer.byteLength(frame.data)
  if (entry.bytes + bytes > L.inputBytesPerSecond) return false
  // Consume before write, including uncertain writes. No retries or replay.
  entry.inputSeq = frame.seq
  entry.bytes += bytes
  try {
    entry.pty.write(frame.data)
    return true
  } catch {
    return false
  }
}
export function terminalFeature(state: TerminalState): HostFeature {
  const { options, entries } = state
  return {
    capability: 'terminal',
    methods: ['terminal.list'],
    async call(method, params) {
      if (state.closed)
        return { ok: false, error: { code: 'internal', message: 'Terminals unavailable.' } }
      const parsed = parseTerminalListParams(params)
      if (method !== 'terminal.list' || !parsed)
        return { ok: false, error: { code: 'bad-request', message: 'Invalid terminal request.' } }
      try {
        reap(state)
        await laneRoot(options.context, parsed.laneId)
        return {
          ok: true,
          data: [...entries.values()]
            .filter((e) => e.laneId === parsed.laneId)
            .map(({ terminalId, laneId, status }) => ({ terminalId, laneId, status })),
        }
      } catch {
        return { ok: false, error: { code: 'unknown-lane', message: 'Lane unavailable.' } }
      }
    },
  }
}
