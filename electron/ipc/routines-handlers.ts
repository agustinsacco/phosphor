import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { validateRoutine, type RoutineInput } from '@shared/routines'
import { handle } from './handle'
import { routineScheduler, routinesSnapshot } from '../routines'
import { configureRoutineBackground } from '../routines/background'
import { folderTaskObstacle } from '../routines/preflight'
import { broadcast } from '../broadcast'
import { checkPiHealth } from '../pi/health'
import { piStubPath } from '../pi/stub'
import { gitInfo } from '../fs/git-info'

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value))
    throw new Error('Invalid routine/run identifier.')
  return value
}

async function input(raw: unknown): Promise<RoutineInput> {
  const r = validateRoutine(raw)
  if (!isAbsolute(r.workspacePath) || !(await stat(r.workspacePath)).isDirectory())
    throw new Error('Choose an existing absolute workspace folder.')
  return { ...r, workspacePath: realpathSync.native(r.workspacePath) }
}

export function registerRoutinesHandlers(): void {
  handle('routines:list', () => routinesSnapshot())
  handle('routines:save', async (_event, raw, routineId, revision) => {
    const r = await input(raw)
    if (routineId !== undefined) id(routineId)
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new Error('Invalid revision.')
    routineScheduler().save(r, routineId, revision)
  })
  handle('routines:check', async (_event, raw) => {
    const r = await input(raw)
    if (!piStubPath()) {
      const health = await checkPiHealth()
      if (!health.ok) throw new Error(health.message ?? 'pi is unavailable.')
    }
    const info = await gitInfo(r.workspacePath)
    if (r.isolated && !info.isRepo)
      throw new Error(
        'Worktree isolation requires a Git repository. Choose Folder task for analysis outside Git.',
      )
    // Report what the runner would refuse instead of only what is permanently
    // misconfigured: these conditions used to be invisible until a run blocked.
    return {
      summary:
        'Folder and pi checked. Model identity is verified at execution. Connector access, account limits, and task results require a real test run, which can have side effects.',
      warning: r.isolated ? null : await folderTaskObstacle(r.workspacePath, r.intent),
    }
  })
  handle('routines:run', (_event, routineId, requestId) =>
    routineScheduler().runNow(id(routineId), id(requestId)),
  )
  handle('routines:history', (_event, routineId, offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new Error('Invalid history offset.')
    return routineScheduler().repository.history(id(routineId), offset, 50)
  })
  // The sidebar calls this on every routine change, including at boot before
  // the user has opened Routines. A routines subsystem that failed to start
  // must not take the sidebar down with it — an empty index hides nothing.
  handle('routines:laneIndex', () => {
    try {
      return routineScheduler().repository.laneIndex()
    } catch {
      return {}
    }
  })
  handle('routines:promoteRun', (_event, runId) => {
    routineScheduler().repository.promote(id(runId))
    broadcast('routines:changed', {})
  })
  handle('routines:cancel', (_event, runId) => routineScheduler().cancel(id(runId)))
  handle('routines:skipNext', (_event, routineId) => {
    routineScheduler().repository.skipNext(id(routineId), Date.now())
    broadcast('routines:changed', {})
  })
  handle('routines:archive', (_event, routineId) => {
    routineScheduler().repository.archive(id(routineId), Date.now())
    broadcast('routines:changed', {})
  })
  handle('routines:pauseAll', () => routineScheduler().pauseAll())
  handle('routines:background', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid background setting.')
    const previous = routineScheduler().repository.background()
    configureRoutineBackground(enabled)
    try {
      routineScheduler().repository.setBackground(enabled)
    } catch (error) {
      configureRoutineBackground(previous)
      throw error
    }
    broadcast('routines:changed', {})
  })
}
