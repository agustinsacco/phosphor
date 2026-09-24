import type { MaintenancePrefs, MaintenanceReport } from '@shared/models'
import { handle } from './handle'
import { registry } from '../registry'
import { getPrefs, setMaintenancePrefs } from '../store'
import { normalizeRealPath } from '../fs/git-worktrees'
import { MaintenanceScheduler } from '../maintenance/scheduler'
import { sweep } from '../maintenance/sweep'
import { routineProtectedPaths } from '../routines'

/**
 * Paths no sweep may touch: every live session's cwd, plus the workspaces the
 * user has open. Both forms are included because git records the path as it
 * was given while session cwds are symlink-resolved, and on macOS those differ
 * (`/tmp` vs `/private/tmp`).
 */
function protectedPaths(): string[] {
  const live = registry.list().map((s) => s.workspacePath)
  const recent = getPrefs().recentWorkspaces.map((w) => w.path)
  const all = [...live, ...recent, ...routineProtectedPaths()]
  return [...new Set([...all, ...all.map(normalizeRealPath)])]
}

async function runSweep(repoPath: string, act: boolean): Promise<MaintenanceReport> {
  const prefs = getPrefs().maintenance
  return sweep({
    repoPath,
    prefs,
    protectedPaths: protectedPaths(),
    liveSessionCount: registry.list().length,
    act,
  })
}

/**
 * The repos a sweep covers: the workspaces the user actually opens, since
 * those are the repos whose lanes Phosphor created in the first place.
 *
 * Only the recent-workspace list, which `getPrefs` has already stripped of
 * worktree folders. Sweeping from inside a worktree would let a sweep reclaim
 * the directory it is running in.
 */
function repoPaths(): string[] {
  return [...new Set(getPrefs().recentWorkspaces.map((w) => w.path))]
}

/**
 * Every repo, one after another. Sequential for the same reason the
 * scheduler is: each sweep runs git and `du` over every worktree. A repo that
 * fails reports its error and does not stop the rest.
 */
async function runAll(act: boolean): Promise<MaintenanceReport[]> {
  const reports: MaintenanceReport[] = []
  for (const repoPath of repoPaths()) reports.push(await runSweep(repoPath, act))
  return reports
}

/** The periodic janitor. */
export const maintenanceScheduler = new MaintenanceScheduler({
  getPrefs: () => getPrefs().maintenance,
  getRepoPaths: repoPaths,
  runSweep: (repoPath, prefs) => runSweep(repoPath, prefs.reclaimMergedWorktrees),
})

export function registerMaintenanceHandlers(): void {
  // Every repo the scheduler covers, not just the one on screen: "Reclaim
  // now" in one workspace used to leave every other workspace's dead lanes
  // on disk, and nothing said so.
  handle('maintenance:scan', () => runAll(false))

  // Explicit user action, so it acts regardless of the pref — but only on what
  // the same policy cleared, so the button can never delete more than a sweep.
  handle('maintenance:run', () => runAll(true))

  handle('maintenance:setPrefs', (_event, value: MaintenancePrefs) => {
    setMaintenancePrefs(value)
  })
}
