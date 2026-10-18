import { join } from 'node:path'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { RoutineScheduler } from '@phosphor/session-runtime/routines/scheduler'
import {
  isRoutineSession,
  routineSessionForPath,
  observeRoutineSession,
} from '@phosphor/session-runtime/routines/ownership'
import type { RoutineOp } from '@phosphor/shared/host-protocol-routines'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { prepareStateDirectory, prepareStateFile } from '../lanes/state-dir'
import { createRoutineExecutor } from './runner'
import { admittedRoutineRoot, executeRoutineOperation } from './operations'
import { createRoutineQueries } from './queries'
import type { HostRoutineOptions, HostRoutineState } from './service-state'

export function routineOwnership(cancel: (id: string) => Promise<void>) {
  return {
    owns: isRoutineSession,
    sessionForPath: routineSessionForPath,
    observe: observeRoutineSession,
    cancel,
  }
}
export function createHostRoutines(options: HostRoutineOptions) {
  const directory = join(options.directory, 'routines')
  prepareStateDirectory(directory, options.uid)
  const repository = new RoutineRepository(prepareStateFile(directory, options.uid))
  const now = options.now ?? Date.now
  const state: HostRoutineState = {
    options,
    repository,
    now,
    closing: false,
    stopped: undefined,
    closed: false,
    scheduler: new RoutineScheduler(
      repository,
      createRoutineExecutor(options.runtime, (path) => admittedRoutineRoot(options, path)),
      options.changed,
      now,
      () => {},
      {
        get closing() {
          return state.closing
        },
        assertCanStart() {
          if (state.closing) throw new Error('stopping')
          options.runtime.life.assertReady()
        },
      },
    ),
  }
  const stop = () => {
    state.closing = true
    return (state.stopped ??= state.scheduler.stop())
  }
  return {
    feature: createRoutineQueries(state),
    scheduler: state.scheduler,
    start() {
      state.scheduler.start()
    },
    stop,
    async close() {
      await stop()
      if (!state.closed) {
        state.closed = true
        repository.close()
      }
    },
    async cancelSession(id: string) {
      const run = repository.pending().find((run) => run.sessionId === id)
      if (!run) throw new Error('routine owner unavailable')
      await state.scheduler.cancelAndWait(run.id)
    },
    execute: (raw: RoutineOp, requestId: string, caps: readonly HostCapability[]) =>
      executeRoutineOperation(state, raw, requestId, caps),
  }
}
export type HostRoutines = ReturnType<typeof createHostRoutines>
