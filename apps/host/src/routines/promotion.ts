import { closeSync, realpathSync } from 'node:fs'
import { isUuid } from '@phosphor/shared/control-api'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { isRoutineSession } from '@phosphor/session-runtime/routines/ownership'
import { isInside } from '@phosphor/session-runtime/fs-safety'
import { openTranscriptFile, verifyTranscriptFile } from '../lanes/transcript/read'
import { laneWorktreePath } from '../lanes/worktree'
import type { HostRoutineState } from './service-state'

function verify(path: string, root: string) {
  const fd = openTranscriptFile(path)
  try {
    return typeof verifyTranscriptFile(fd, path, root) !== 'string'
  } finally {
    closeSync(fd)
  }
}

export function promoteRoutine(state: HostRoutineState, id: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!isUuid(id)) throw new OpRefusal('bad-request', 'Name one routine run.')
  const { options, repository } = state
  const ports = options.promotion
  if (!ports || state.closing) throw new OpRefusal('unavailable', 'Routine promotion unavailable.')
  let run
  try {
    run = repository.run(id)
  } catch {
    throw new OpRefusal('bad-request', 'No such run.')
  }
  if (
    state.deleting.has(run.routineId) ||
    run.status === 'queued' ||
    run.status === 'running' ||
    (run.sessionId && isRoutineSession(run.sessionId))
  )
    throw new OpRefusal('busy', 'Wait for the routine run to settle.')
  const root = options.store
    .listRepositories()
    .find((row) => row.path === run.definition.workspacePath)
  const cwd = run.workspacePath ?? root?.path
  const file = run.sessionPath
  if (!cwd || !root || !isInside(root.path, cwd) || !file)
    throw new OpRefusal('bad-request', 'This run has no available workspace or transcript.')
  try {
    if (
      realpathSync.native(root.path) !== root.path ||
      realpathSync.native(cwd) !== cwd ||
      (cwd !== root.path && (!run.branch || laneWorktreePath(root.path, run.branch) !== cwd)) ||
      !verify(file, ports.sessionsRoot)
    )
      throw new Error('invalid run files')
  } catch {
    throw new OpRefusal('bad-request', 'This run has no available workspace or transcript.')
  }
  const lane = ports.adopt({
    repositoryId: root.id,
    cwd,
    sessionFile: file,
    branch: run.branch,
    worktree: cwd !== root.path,
    title: run.definition.name,
  })
  if (lane.removedAt !== null)
    throw new OpRefusal('bad-request', 'Restore the archived lane first.')
  repository.promote(id)
  ports.publish(lane.laneId)
  options.changed()
  return lane.laneId
}
