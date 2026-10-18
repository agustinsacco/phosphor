import type { MaintenanceReport } from '@shared/models'
import { registry } from '../registry'
import { getPrefs } from '../store'
import { normalizeRealPath } from '../fs/git-worktrees'
import { MaintenanceScheduler } from './scheduler'
import { sweep } from './sweep'
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
export async function runAll(act: boolean): Promise<MaintenanceReport[]> {
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
