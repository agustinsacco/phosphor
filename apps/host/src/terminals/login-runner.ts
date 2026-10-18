import { randomUUID } from 'node:crypto'
import { TERMINAL_LIMITS as L, type TerminalOp } from '@phosphor/shared/host-protocol-terminals'
import type { runInTerminal, TerminalRun } from '../machine/terminal'
import { createEntry, type TerminalState } from './service-state'
import { kill } from './lifecycle'
import { output } from './output'
import { TerminalForbidden } from './operations'

export function machineOp(state: TerminalState, owner: string, op: TerminalOp) {
  const { entries } = state
  if (state.closed || op.type === 'terminal.create') throw new TerminalForbidden('forbidden')
  const entry = entries.get(op.terminalId)
  if (!entry?.login || entry.login.owner !== owner) throw new TerminalForbidden('forbidden')
  if (op.type === 'terminal.resize') entry.pty?.resize(op.cols, op.rows)
  else {
    kill(state, entry)
    entries.delete(entry.terminalId)
    entry.listeners.clear()
  }
  return null
}
/** Only the Host's CLI login runner supplies these process options. Never wire input. */
export function loginRunner(
  state: TerminalState,
  owner: string,
  started: (id: string) => void,
): typeof runInTerminal {
  const { options, entries, now } = state
  return (file, args, settings) =>
    new Promise<TerminalRun>((resolve) => {
      if (state.closed || entries.size >= L.perHost)
        return resolve({ code: null, error: 'unavailable' })
      const entry = createEntry({ terminalId: randomUUID(), laneId: '', status: 'running' })
      entry.login = { owner, finish: resolve }
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
          const watched = entry.listeners.size > 0
          kill(state, entry, exitCode)
          // An exit can beat Desktop's first subscribe. Retain only a bounded,
          // content-free tombstone so its reset reports completion, not a hung modal.
          if (entry.login) entry.login.disconnectedAt = now()
          if (watched) entries.delete(entry.terminalId)
          entry.listeners.clear()
        })
        started(entry.terminalId)
      } catch {
        kill(state, entry)
        entries.delete(entry.terminalId)
        resolve({ code: null, error: 'unavailable' })
      }
    })
}
