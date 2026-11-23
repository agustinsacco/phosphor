import type { MaintenanceReport } from '@shared/models'
import { localRuntimeMode } from '../local-machine/mode'
import { sameMachine } from '../local-machine/same-machine'
import { registry } from '../registry'
import { getPrefs } from '../store'
import { normalizeRealPath } from '@phosphor/session-runtime/git/worktree-metadata'
import { initializeReport } from './reclaim'
import { liveLanePaths } from './reservation'
import { MaintenanceScheduler } from './scheduler'
import { sweep } from './sweep'
import { routineProtectedPaths } from '../routines'

export const SWEEP_SERVICE_DOWN = "This Mac's Phosphor service isn't connected, so nothing was swept."

/**
 * The folders a sweep covers and the lanes running in them. In-app: the
 * recent workspaces and the registry. In daemon mode: the folders and live
 * lanes in the service's projection, or undefined while it is not connected.
 */
function workspaceFacts(): { folders: string[]; live: string[] } | undefined {
  if (localRuntimeMode() !== 'daemon')
    return {
      folders: getPrefs().recentWorkspaces.map((w) => w.path),
      live: registry.list().map((s) => s.workspacePath),
    }
  const view = sameMachine()
  const live = liveLanePaths()
  if (!view || !live) return undefined
  return { folders: view.repositories.map((r) => r.path), live }
}

/**
 * Paths no sweep may touch: every live lane's cwd, plus the workspaces the
 * user has open. Both forms are included because git records the path as it
 * was given while session cwds are symlink-resolved, and on macOS those differ
 * (`/tmp` vs `/private/tmp`).
 */
function protectedPaths(): string[] {
  const facts = workspaceFacts()
  if (!facts) throw new Error(SWEEP_SERVICE_DOWN)
  const all = [...facts.live, ...facts.folders, ...routineProtectedPaths()]
  return [...new Set([...all, ...all.map(normalizeRealPath)])]
}

async function runSweep(repoPath: string, act: boolean): Promise<MaintenanceReport> {
  const facts = workspaceFacts()
  if (!facts)
    return { ...initializeReport(repoPath, Date.now(), 0), errors: [SWEEP_SERVICE_DOWN] }
  const prefs = getPrefs().maintenance
  return sweep({
    repoPath,
    prefs,
    protectedPaths: protectedPaths(),
    currentProtectedPaths: protectedPaths,
    liveSessionCount: facts.live.length,
    act,
  })
}

/**
 * The repos a sweep covers: the workspaces the user actually opens, since
 * those are the repos whose lanes Phosphor created in the first place.
 *
 * In-app, only the recent-workspace list, which `getPrefs` has already
 * stripped of worktree folders. Sweeping from inside a worktree would let a
 * sweep reclaim the directory it is running in. In daemon mode, the folders
 * the service keeps; each is protected, so none is reclaimed from inside.
 */
function repoPaths(): string[] | undefined {
  const facts = workspaceFacts()
  return facts && [...new Set(facts.folders)]
}

/**
 * Every repo, one after another. Sequential for the same reason the
 * scheduler is: each sweep runs git and `du` over every worktree. A repo that
 * fails reports its error and does not stop the rest.
 */
export async function runAll(act: boolean): Promise<MaintenanceReport[]> {
  const repos = repoPaths()
  if (!repos) throw new Error(SWEEP_SERVICE_DOWN)
  const reports: MaintenanceReport[] = []
  for (const repoPath of repos) reports.push(await runSweep(repoPath, act))
  return reports
}

/** The periodic janitor. */
export const maintenanceScheduler = new MaintenanceScheduler({
  getPrefs: () => getPrefs().maintenance,
  getRepoPaths: () => repoPaths() ?? [],
  runSweep: (repoPath, prefs) => runSweep(repoPath, prefs.reclaimMergedWorktrees),
})
