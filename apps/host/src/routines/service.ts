import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { RoutineScheduler } from '@phosphor/session-runtime/routines/scheduler'
import {
  isRoutineSession,
  routineSessionForPath,
  observeRoutineSession,
} from '@phosphor/session-runtime/routines/ownership'
import {
  ROUTINE_LIMITS,
  parseRoutineOp,
  parseRoutineParams,
  routineRequiresControl,
  type RoutineOp,
  type RemoteRoutine,
} from '@phosphor/shared/host-protocol-routines'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { validateRoutine, type Routine } from '@phosphor/shared/routines'
import type { HostRuntime } from '../session/runtime'
import type { HostStore } from '../lanes/store'
import type { HostFeature } from '../features/feature'
import { prepareStateDirectory, prepareStateFile } from '../lanes/state-dir'
import { isInsideRoot } from '../machine/repositories'
import { createRoutineExecutor } from './runner'

export function routineOwnership(cancel: (id: string) => Promise<void>) {
  return {
    owns: isRoutineSession,
    sessionForPath: routineSessionForPath,
    observe: observeRoutineSession,
    cancel,
  }
}
export function createHostRoutines(options: {
  directory: string
  uid: number | undefined
  store: Pick<HostStore, 'listRepositories'>
  runtime: HostRuntime
  changed(): void
  now?: () => number
}) {
  const directory = join(options.directory, 'routines')
  prepareStateDirectory(directory, options.uid)
  const repository = new RoutineRepository(prepareStateFile(directory, options.uid))
  const now = options.now ?? Date.now
  let closing = false
  let stopped: Promise<void> | undefined
  let closed = false
  const stop = () => {
    closing = true
    return (stopped ??= scheduler.stop())
  }
  const root = (path: string): string => {
    const configured = options.store.listRepositories().find((entry) => entry.path === path)
    if (!configured || realpathSync.native(path) !== path) throw new Error('repository unavailable')
    return path
  }
  const scheduler = new RoutineScheduler(
    repository,
    createRoutineExecutor(options.runtime, root),
    options.changed,
    now,
    () => {},
    {
      get closing() {
        return closing
      },
      assertCanStart() {
        if (closing) throw new Error('stopping')
        options.runtime.life.assertReady()
      },
    },
  )
  function remote(routine: Routine): RemoteRoutine {
    const repositoryId = options.store
      .listRepositories()
      .find((entry) => entry.path === routine.workspacePath)?.id
    if (!repositoryId) throw new Error('repository unavailable')
    const { workspacePath: _path, attention: _attention, ...rest } = routine
    return { ...rest, repositoryId }
  }
  const feature: HostFeature = {
    capability: 'routines',
    methods: ['routines.list', 'routines.history'],
    async call(method, params) {
      if (closing) return { ok: false, error: { code: 'internal', message: 'Routines stopping.' } }
      const parsed = parseRoutineParams(method, params)
      if (!parsed)
        return { ok: false, error: { code: 'bad-request', message: 'Invalid routine query.' } }
      try {
        if (method === 'routines.list') return { ok: true, data: repository.routines().map(remote) }
        if (!parsed.routineId) throw new Error('missing id')
        repository.get(parsed.routineId)
        return {
          ok: true,
          data: repository
            .history(parsed.routineId, parsed.offset, ROUTINE_LIMITS.history)
            .map(({ id, routineId, status, scheduledAt, startedAt, endedAt }) => ({
              id,
              routineId,
              status,
              scheduledAt,
              startedAt,
              endedAt,
            })),
        }
      } catch {
        return { ok: false, error: { code: 'internal', message: 'Routine query unavailable.' } }
      }
    },
  }
  return {
    feature,
    scheduler,
    start() {
      scheduler.start()
    },
    stop,
    async close() {
      await stop()
      if (!closed) {
        closed = true
        repository.close()
      }
    },
    async cancelSession(id: string) {
      const run = repository.pending().find((run) => run.sessionId === id)
      if (!run) throw new Error('routine owner unavailable')
      await scheduler.cancelAndWait(run.id)
    },
    async execute(raw: RoutineOp, requestId: string, caps: readonly HostCapability[]) {
      const op = parseRoutineOp(raw)
      if (!op || closing) throw new Error('invalid routine operation')
      if (
        !caps.includes('routines') ||
        (routineRequiresControl(op) && !caps.includes('sessions.control'))
      )
        throw new Error('forbidden')
      switch (op.type) {
        case 'routine.save': {
          const configured = options.store
            .listRepositories()
            .find((entry) => entry.id === op.routine.repositoryId)
          if (!configured) throw new Error('repository unavailable')
          root(configured.path)
          if (!op.routineId && repository.routines().length >= ROUTINE_LIMITS.routines)
            throw new Error('routine limit')
          const { repositoryId: _id, ...input } = op.routine
          // Creation never silently authorizes automation. A later controller save acknowledges it.
          const saved = repository.save(
            validateRoutine({
              ...input,
              workspacePath: configured.path,
              enabled: op.routineId ? input.enabled : false,
              trusted: op.routineId ? input.trusted : false,
            }),
            now(),
            op.routineId,
            op.expectedRevision ?? undefined,
          )
          options.changed()
          scheduler.tick()
          return { routineId: saved.id, revision: saved.revision }
        }
        case 'routine.run':
          return { runId: scheduler.runNow(op.routineId, requestId).id }
        case 'routine.cancel':
          repository.run(op.runId)
          await scheduler.cancelAndWait(op.runId)
          return {}
        case 'routine.skipNext':
          repository.skipNext(op.routineId, now())
          break
        case 'routine.archive':
          repository.archive(op.routineId, now())
          break
        case 'routine.pauseAll':
          scheduler.pauseAll()
          break
        case 'routine.delete': {
          if (
            repository
              .pending()
              .some((run) => run.routineId === op.routineId && run.status === 'running')
          )
            throw new Error('running')
          // Refuse beyond this bound rather than partially forgetting owned transcripts.
          const runs = repository.history(op.routineId, 0, 1001)
          if (runs.length > 1000) throw new Error('history limit')
          repository.archive(op.routineId, now())
          options.changed()
          for (const run of runs)
            if (run.sessionPath && !run.promoted) {
              const source = root(run.definition.workspacePath)
              const cwd = realpathSync.native(run.workspacePath ?? source)
              if (!isInsideRoot(cwd, source)) throw new Error('repository unavailable')
              if (closing) throw new Error('stopping')
              await options.runtime.remove({ repository: cwd, sessionPath: run.sessionPath })
            }
          if (closing) throw new Error('stopping')
          repository.delete(op.routineId)
          break
        }
      }
      options.changed()
      return {}
    },
  }
}
export type HostRoutines = ReturnType<typeof createHostRoutines>
