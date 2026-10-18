import { randomUUID } from 'node:crypto'
import { TERMINAL_LIMITS as L, type TerminalOp } from '@phosphor/shared/host-protocol-terminals'
import type { runInTerminal, TerminalRun } from '../machine/terminal'
import { createEntry, type TerminalState } from './service-state'
import { kill } from './lifecycle'
import { output } from './output'
import { TerminalForbidden } from './operations'

export function machineOp(
  state: TerminalState,
  owner: string,
  op: TerminalOp,
  configuration = false,
) {
  const { entries } = state
  if (state.closed || op.type === 'terminal.create') throw new TerminalForbidden('forbidden')
  const entry = entries.get(op.terminalId)
  if (
    !entry?.login ||
    entry.login.owner !== owner ||
    (entry.login.configuration &&
      (!configuration || entry.login.authorized?.() === false) &&
      op.type !== 'terminal.kill')
  )
    throw new TerminalForbidden('forbidden')
  if (op.type === 'terminal.resize') entry.pty?.resize(op.cols, op.rows)
  else {
    kill(state, entry)
    entries.delete(entry.terminalId)
    entry.listeners.clear()
  }
  return null
}
function finishLogin(
  state: TerminalState,
  entry: import('./service-state').Entry,
  exitCode: number,
) {
  const watched = entry.listeners.size > 0
  kill(state, entry, exitCode)
  if (entry.login) entry.login.disconnectedAt = state.now()
  if (watched) state.entries.delete(entry.terminalId)
  entry.listeners.clear()
}
/** Internal only: authoritative verification must finish before the public exit. */
export function completeLogin(state: TerminalState, owner: string, id: string, exitCode: number) {
  const entry = state.entries.get(id)
  if (
    entry?.login?.owner === owner &&
    entry.login.deferExit &&
    entry.login.nativeExitCode !== undefined
  )
    finishLogin(state, entry, exitCode)
}
/** Only the Host's CLI login runner supplies these process options. Never wire input. */
export function loginRunner(
  state: TerminalState,
  owner: string,
  started: (id: string) => void,
  configuration = false,
  deferExit = false,
  authorized?: () => boolean,
): typeof runInTerminal {
  const { options, entries } = state
  return (file, args, settings) =>
    new Promise<TerminalRun>((resolve) => {
      if (state.closed || entries.size >= L.perHost)
        return resolve({ code: null, error: 'unavailable' })
      const entry = createEntry({ terminalId: randomUUID(), laneId: '', status: 'running' })
      entry.login = { owner, configuration, deferExit, authorized, finish: resolve }
      entries.set(entry.terminalId, entry)
      try {
        entry.pty = options.native.spawn(file, [...args], {
          cwd: settings.cwd,
          env: settings.env,
          cols: 80,
          rows: 24,
          name: 'xterm-256color',
        })
        entry.pty.onData((data) => output(state, entry, data))
        entry.pty.onExit(({ exitCode }) => {
          if (entry.login?.deferExit) {
            entry.pty = undefined
            entry.login.nativeExitCode = exitCode
            entry.login.finish({ code: exitCode })
          } else finishLogin(state, entry, exitCode)
          // A bounded, content-free tombstone also handles late subscribers.
        })
        started(entry.terminalId)
      } catch {
        kill(state, entry)
        entries.delete(entry.terminalId)
        resolve({ code: null, error: 'unavailable' })
      }
    })
}
