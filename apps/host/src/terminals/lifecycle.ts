import { PROVIDER_LOGIN_LIMITS } from '@phosphor/shared/host-protocol-providers'
import { FORCED_EXIT_CODE, type Entry, type TerminalState } from './service-state'
import { emit } from './output'

export function persist(state: TerminalState) {
  state.options.save(
    [...state.entries.values()]
      .filter((entry) => !entry.login)
      .map(({ terminalId, laneId, status }) => ({
        terminalId,
        laneId,
        status,
      })),
  )
}
export function alive(state: TerminalState, laneId: string) {
  const lane = state.options.context.store.getLane(laneId)
  return (
    lane &&
    lane.removedAt === null &&
    state.options.context.store.listRepositories().some((r) => r.id === lane.repositoryId)
  )
}
export function kill(state: TerminalState, entry: Entry, exitCode = FORCED_EXIT_CODE) {
  const pty = entry.pty
  entry.pty = undefined
  entry.status = 'exited'
  entry.login?.finish({ code: null })
  if (entry.login) {
    entry.chunks = []
    entry.outputBytes = 0
  }
  if (pty) {
    entry.exitCode = exitCode
    emit(entry, {
      type: 'terminal.exit',
      id: 'live',
      terminalId: entry.terminalId,
      epoch: state.options.epoch,
      seq: ++entry.seq,
      exitCode,
    })
  }
  try {
    pty?.kill()
  } catch {
    /* Already exited. */
  }
}
export function reap(state: TerminalState) {
  let changed = false
  for (const [id, entry] of state.entries)
    if (
      entry.login
        ? entry.login.disconnectedAt !== undefined &&
          state.now() - entry.login.disconnectedAt >= PROVIDER_LOGIN_LIMITS.disconnectMs
        : !alive(state, entry.laneId)
    ) {
      kill(state, entry)
      state.entries.delete(id)
      entry.listeners.clear()
      changed = true
    }
  if (changed) persist(state)
}
export function close(state: TerminalState) {
  state.closed = true
  clearInterval(state.timer)
  for (const entry of state.entries.values()) {
    kill(state, entry)
    entry.listeners.clear()
  }
}
export function presence(state: TerminalState, owner: string, connected: boolean, revoked = false) {
  for (const [id, entry] of state.entries) {
    if (entry.login?.owner !== owner) continue
    if (revoked) {
      kill(state, entry)
      entry.listeners.clear()
      state.entries.delete(id)
    } else if (entry.status === 'running')
      entry.login.disconnectedAt = connected ? undefined : state.now()
  }
}
