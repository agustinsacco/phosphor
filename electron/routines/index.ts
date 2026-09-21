import { app, Notification } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { piStubPath } from '../pi/stub'
import { RUN_LABELS, type RoutinesSnapshot } from '@shared/routines'
import { RoutineRepository } from './repository'
import { RoutineScheduler } from './scheduler'
import { executeRoutine } from './runner'
import { configureRoutineBackground } from './background'

let scheduler: RoutineScheduler | undefined
let error: string | null = null
const changed = (): void => broadcast('routines:changed', {})

export function startRoutines(): void {
  try {
    const directory = app.getPath('userData')
    mkdirSync(directory, { recursive: true })
    // A dev launch must never execute the installed app's saved automations.
    const file = !app.isPackaged && !piStubPath() ? 'routines-dev.sqlite' : 'routines.sqlite'
    const repository = new RoutineRepository(join(directory, file))
    scheduler = new RoutineScheduler(repository, executeRoutine, changed, Date.now, (run) => {
      if (piStubPath() || !Notification.isSupported() || run.status === 'cancelled') return
      new Notification({
        title: `${run.definition.name} · ${RUN_LABELS[run.status]}`,
        body: run.reason.slice(0, 240),
      }).show()
    })
    configureRoutineBackground(repository.background())
    scheduler.start()
  } catch (cause) {
    error = `Routines unavailable: ${String(cause)}`
    log('routines', 'startup failed', { error })
    changed()
  }
}

export function routineScheduler(): RoutineScheduler {
  if (error || !scheduler) throw new Error(error ?? 'Routines are not ready.')
  return scheduler
}

export function routinesSnapshot(): RoutinesSnapshot {
  try {
    return routineScheduler().snapshot()
  } catch (cause) {
    return { routines: [], runs: [], background: false, error: String(cause) }
  }
}

export function routineProtectedPaths(): string[] {
  if (error) throw new Error('Cannot reclaim worktrees while routine ownership is unavailable.')
  if (!scheduler) return []
  return [
    ...scheduler.repository
      .routines()
      .filter((r) => !r.archived)
      .map((r) => r.workspacePath),
    ...scheduler.repository.pending().flatMap((r) => (r.workspacePath ? [r.workspacePath] : [])),
  ]
}

/** Lane deletion uses the normal cancellation path and waits for its writer. */
export async function cancelRoutineSession(sessionId: string): Promise<void> {
  const owner = routineScheduler()
  const run = owner.repository.pending().find((r) => r.sessionId === sessionId)
  if (!run) throw new Error('Cannot find the active routine run for this lane.')
  await owner.cancelAndWait(run.id)
}

export function hasPendingRoutineWork(): boolean {
  return Boolean(scheduler?.repository.pending().length)
}

export async function stopRoutines(): Promise<void> {
  await scheduler?.stop()
}
export function wakeRoutines(): void {
  scheduler?.tick()
}
