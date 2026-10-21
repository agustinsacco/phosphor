import { PROVIDER_LOGIN_LIMITS } from '@phosphor/shared/host-protocol-providers'
import { FORCED_EXIT_CODE, type Entry, type TerminalState } from './service-state'
import { emit } from './output'

export function persist(state: TerminalState) {
  state.options.save(
    [...state.entries.values()]
      // Machine shells cannot outlive a restart, so there is nothing to report later.
      .filter((entry) => !entry.login && !entry.machine)
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
  const wasRunning = entry.status === 'running'
  entry.pty = undefined
  entry.status = 'exited'
  entry.login?.finish({
    code: entry.login.configuration && exitCode !== FORCED_EXIT_CODE ? exitCode : null,
  })
  if (entry.login) {
    entry.chunks = []
    entry.outputBytes = 0
  }
  if (pty || wasRunning) {
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
        : !entry.machine && !alive(state, entry.laneId)
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
export function authorizationChanged(state: TerminalState) {
  for (const [id, entry] of state.entries) {
    if (entry.login?.configuration && entry.login.authorized && !entry.login.authorized()) {
      kill(state, entry)
      entry.listeners.clear()
      state.entries.delete(id)
    }
  }
}
export function presence(state: TerminalState, owner: string, connected: boolean, revoked = false) {
  authorizationChanged(state)
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
