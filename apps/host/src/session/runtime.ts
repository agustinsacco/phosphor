import { createDrain } from './lifecycle'
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
    drain,
    async mutateStoppedSession<T>(path: string, change: () => Promise<T>): Promise<T> {
      state.paths.cancelSessionOpens(path)
      return state.paths.withSessionPath(path, async () => {
        if (state.registry.list().some((lane) => lane.diskPath === path))
          throw new Error('Stop the lane before changing its saved files.')
        return change()
      })
    },
  }
}

export type HostRuntime = ReturnType<typeof createHostRuntime>
