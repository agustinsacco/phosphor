import { createDrain, endTurn, within } from './lifecycle'
import { createRuntimeOperations } from './runtime-operations'
import { createRuntimeState, type HostMachine, type RuntimeOptions } from './runtime-state'
import { wireRuntimeDeletion, wireRuntimeService, wireRuntimeStartup } from './runtime-wiring'

export { commandRefusal } from './command-policy'
export { unlinkTranscript } from './transcript-removal'
export { RequestError, type Delivery, type HostMachine } from './runtime-state'

/**
 * One machine-bound registry and path-lock domain, shared by service and deletion.
 * The lifecycle starts in booting; callers mark it ready after machine validation.
 */
export function createHostRuntime(machine: HostMachine, options: RuntimeOptions = {}) {
  const state = createRuntimeState(machine, options)
  const spawn = wireRuntimeStartup(state)
  const service = wireRuntimeService(state, spawn)
  const deleteLane = wireRuntimeDeletion(state)
  const ownerDeleteLane = options.ownerTrashTranscript
    ? wireRuntimeDeletion(state, options.ownerTrashTranscript)
    : deleteLane
  const drain = createDrain({
    life: state.life,
    registry: state.registry,
    groups: state.groups,
    timings: state.timings,
    log: machine.log.write,
  })
  machine.log.write('host', 'runtime', {
    pi: [machine.pi.binaryPath, ...machine.pi.prefixArgs],
    names: Object.keys(machine.env).sort(),
    path: machine.env.PATH!.split(':'),
    roots: state.roots,
    resourceRoot: machine.resourceRoot,
  })
  return {
    ...createRuntimeOperations(state, service, deleteLane, ownerDeleteLane),
    ...(options.leases ? { leases: options.leases } : {}),
    life: state.life,
    async refreshDirectives(project?: string) {
      const updates = state.registry.list().flatMap(({ sessionId }) => {
        const s = state.registry.get(sessionId)
        return s?.client.alive && s.refreshDirectives
          ? [s.refreshDirectives(s.client.request.bind(s.client), project)]
          : []
      })
      // An unresponsive pi must not hold the settings op. A late push is still ordered
      // on that process and recomposes from current preferences, never from stale args.
      const results = await within(Promise.allSettled(updates), Date.now() + 5000)
      if (!results) return updates.length
      return results.filter((r) => r.status === 'rejected' || !r.value).length
    },
    drain,
    /** The drain's abort-and-save step, with no stop: a service pause's Abort now. */
    async abortTurns(): Promise<string[]> {
      const sessions = state.registry
        .list()
        .flatMap((info) => state.registry.get(info.sessionId) ?? [])
      const ends = await Promise.all(
        sessions.map((session) =>
          endTurn(session.client, state.timings.abortMs).catch(() => 'unfinished' as const),
        ),
      )
      return sessions.flatMap((session, i) => (ends[i] === 'idle' ? [] : [session.sessionId]))
    },
    async mutateStoppedSession<T>(path: string, change: () => Promise<T>): Promise<T> {
      state.paths.cancelSessionOpens(path)
      return state.paths.withSessionPath(path, async () => {
        if (state.registry.list().some((lane) => lane.diskPath === path))
          throw new Error('Stop the lane before changing its saved files.')
        return change()
      })
    },
    /** Reads a transcript, live or not, inside its path lock: a fork's source (P1). */
    withSessionFile<T>(path: string, read: () => Promise<T>): Promise<T> {
      return state.paths.withSessionPath(path, read)
    },
  }
}

export type HostRuntime = ReturnType<typeof createHostRuntime>
