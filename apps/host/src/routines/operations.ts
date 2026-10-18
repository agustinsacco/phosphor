import { realpathSync } from 'node:fs'
import {
  ROUTINE_LIMITS,
  parseRoutineOp,
  routineRequiresControl,
  type RoutineOp,
} from '@phosphor/shared/host-protocol-routines'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { validateRoutine } from '@phosphor/shared/routines'
import { isInside } from '../fs-safety'
import type { HostRoutineOptions, HostRoutineState } from './service-state'

export function admittedRoutineRoot(options: HostRoutineOptions, path: string): string {
  const configured = options.store.listRepositories().find((entry) => entry.path === path)
  if (!configured || realpathSync.native(path) !== path) throw new Error('repository unavailable')
  return path
}

function saveRoutine(state: HostRoutineState, op: Extract<RoutineOp, { type: 'routine.save' }>) {
  const { options, repository, scheduler, now } = state
  const configured = options.store
    .listRepositories()
    .find((entry) => entry.id === op.routine.repositoryId)
  if (!configured) throw new Error('repository unavailable')
  admittedRoutineRoot(options, configured.path)
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

async function deleteRoutine(state: HostRoutineState, routineId: string) {
  const { options, repository, now } = state
  if (repository.pending().some((run) => run.routineId === routineId && run.status === 'running'))
    throw new Error('running')
  // Refuse beyond this bound rather than partially forgetting owned transcripts.
  const runs = repository.history(routineId, 0, 1001)
  if (runs.length > 1000) throw new Error('history limit')
  repository.archive(routineId, now())
  options.changed()
  for (const run of runs)
    if (run.sessionPath && !run.promoted) {
      const source = admittedRoutineRoot(options, run.definition.workspacePath)
      const cwd = realpathSync.native(run.workspacePath ?? source)
      if (!isInside(source, cwd)) throw new Error('repository unavailable')
      if (state.closing) throw new Error('stopping')
      await options.runtime.remove({ repository: cwd, sessionPath: run.sessionPath })
    }
  if (state.closing) throw new Error('stopping')
  repository.delete(routineId)
  options.changed()
  return {}
}

export async function executeRoutineOperation(
  state: HostRoutineState,
  raw: RoutineOp,
  requestId: string,
  caps: readonly HostCapability[],
) {
  const { repository, scheduler, options, now } = state
  const op = parseRoutineOp(raw)
  if (!op || state.closing) throw new Error('invalid routine operation')
  if (
    !caps.includes('routines') ||
    (routineRequiresControl(op) && !caps.includes('sessions.control'))
  )
    throw new Error('forbidden')
  switch (op.type) {
    case 'routine.save':
      return saveRoutine(state, op)
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
    case 'routine.delete':
      return deleteRoutine(state, op.routineId)
  }
  options.changed()
  return {}
}
