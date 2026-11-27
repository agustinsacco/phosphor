import { sessionOwnerOf, type SessionOwner } from './session-owner'
import { createDrain, endTurn, within } from './lifecycle'
import { createRuntimeOperations } from './runtime-operations'
import { createRuntimeState, type HostMachine, type RuntimeOptions } from './runtime-state'
import { wireRuntimeDeletion, wireRuntimeService, wireRuntimeStartup } from './runtime-wiring'
import { isReservedPath } from './reserved-lanes'

const NOT_A_LANE_FILE = 'That file is not a lane file on this Host.'

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
  const sessionOwner = (path: string) =>
    sessionOwnerOf(state.registry.list(), path, {
      alive: (id) => !!state.registry.get(id)?.client.alive,
      stopping: (id) => state.registry.isStopping(id),
    })
  return {
    ...createRuntimeOperations(state, service, deleteLane, ownerDeleteLane),
    ...(options.leases ? { leases: options.leases } : {}),
    life: state.life,
    /** Lanes with a live pi process, reserved lanes included. */
    liveLanes: () => state.registry.list().length,
    /** Whether a live lane on this transcript is working: Brain waits before reading it. */
    sessionFileBusy: (path: string) => sessionFileBusy(state, path),
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
      if (isReservedPath(state, path)) throw new Error(NOT_A_LANE_FILE)
      state.paths.cancelSessionOpens(path)
      return state.paths.withSessionPath(path, async () => {
        if (sessionOwner(path)) throw new Error('Stop the lane before changing its saved files.')
        return change()
      })
    },
    /** Inside the path lock, a fork may read live; a rename checks who owns the file. */
    async withSessionFile<T>(
      path: string,
      use: (owner: () => SessionOwner | undefined) => Promise<T>,
    ): Promise<T> {
      if (isReservedPath(state, path)) throw new Error(NOT_A_LANE_FILE)
      return state.paths.withSessionPath(path, () => use(() => sessionOwner(path)))
    },
  }
}

function sessionFileBusy(state: ReturnType<typeof createRuntimeState>, path: string) {
  return state.registry.list().some(({ sessionId }) => {
    const client = state.registry.get(sessionId)?.client
    return client?.sessionFile === path && client.activity.busy
  })
}

export type HostRuntime = ReturnType<typeof createHostRuntime>
