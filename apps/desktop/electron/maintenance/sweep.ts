import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { MaintenancePrefs, MaintenanceReport } from '@shared/models'
import { git } from '@phosphor/session-runtime/git/git-exec'
import {
  isBranchMerged,
  landedViaPullRequest,
  listWorktrees,
  pruneWorktrees,
} from '../fs/git-worktrees'
import { sessionDirForCwd } from '../pi/pi-paths'
import { log } from '../debug-log'
import { selectReclaimable, totalBytes, type WorktreeFacts } from './policy'
import { initializeReport, reclaimCandidates } from './reclaim'
import { conversationFacts } from './conversations'
import { removeCompletedWorktree } from './removal'

const execFileAsync = promisify(execFile)

/**
 * Disk size of a directory, in bytes.
 *
 * Shells out to `du` rather than walking with `fs`: a lane's `node_modules`
 * holds six figures of files, and a recursive stat walk of 45 of them takes
 * long enough to be felt. `du` is unavailable on Windows, and an unmeasured
 * size is reported as null rather than guessed — the report says "unknown",
 * and the policy never depends on the number.
 */
export async function directorySize(path: string): Promise<number | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await execFileAsync('du', ['-sk', path], { timeout: 30_000 })
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10)
    return Number.isFinite(kb) ? kb * 1024 : null
  } catch {
    return null
  }
}

/** Newest mtime of anything that marks the lane as used. */
async function lastWrite(worktreePath: string): Promise<number> {
  const times = await Promise.all(
    // The worktree itself, plus pi's session directory for that cwd: a lane
    // read but not edited leaves the directory untouched while its transcript
    // keeps moving, and reclaiming a lane someone is still reading is the
    // failure this guards.
    [worktreePath, sessionDirForCwd(worktreePath)].map(async (p) => {
      try {
        return (await stat(p)).mtimeMs
      } catch {
        return 0
      }
    }),
  )
  return Math.max(...times)
}

/** GitHub lookups in flight at once. Each is a `gh` process and a network call. */
const PR_LOOKUPS = 4

async function gatherFacts(repoPath: string, measure: boolean): Promise<WorktreeFacts[]> {
  const worktrees = await listWorktrees(repoPath)
  const facts: WorktreeFacts[] = await Promise.all(
    worktrees.map(async (w) => {
      const conversations = await conversationFacts(w.path)
      return {
        path: w.path,
        realPath: w.realPath,
        branch: w.branch,
        head: w.head,
        isMain: w.isMain,
        // Unknown dirty state is not permission to delete.
        dirtyCount: w.dirtyCount < 0 ? 1 : w.dirtyCount,
        locked: w.locked,
        ...conversations,
        merged: w.isMain || !w.branch ? false : await isBranchMerged(repoPath, w.branch),
        lastWriteMs: Math.max(await lastWrite(w.path), conversations.lastWriteMs),
        bytes: measure ? await directorySize(w.path) : null,
      }
    }),
  )
  // Git misses most lanes that landed as a PR (see `landedViaPullRequest`).
  // Ask GitHub only where the answer can matter: a clean lane git could not
  // prove. A dirty lane is held whatever its merge state.
  const unproven = facts.filter((f) => f.branch && !f.isMain && !f.merged && f.dirtyCount === 0)
  const next = async (): Promise<void> => {
    for (let f = unproven.shift(); f; f = unproven.shift()) {
      f.merged = await landedViaPullRequest(repoPath, f.branch!)
    }
  }
  await Promise.all(Array.from({ length: PR_LOOKUPS }, next))
  return facts
}

export interface SweepOptions {
  repoPath: string
  prefs: MaintenancePrefs
  /** Real paths of live session cwds and the open workspace. Never reclaimed. */
  protectedPaths: string[]
  liveSessionCount: number
  /**
   * Delete, rather than only measure. The scheduler passes the pref; the
   * Settings button passes true so "Reclaim now" works without flipping it.
   */
  act: boolean
  now?: number
  /** Re-read ownership and workspace protection immediately before removal. */
  currentProtectedPaths?: () => string[]
}

/**
 * One maintenance pass over a repository.
 *
 * Always measures. Deletes only when `act` is set AND the policy cleared the
 * directory, and even then delegates to `removeWorktree`, which refuses a
 * dirty tree on its own and only force-deletes a branch it can prove landed.
 */
export async function sweep({
  repoPath,
  prefs,
  protectedPaths,
  liveSessionCount,
  act,
  now = Date.now(),
  currentProtectedPaths = () => protectedPaths,
}: SweepOptions): Promise<MaintenanceReport> {
  const report = initializeReport(repoPath, now, liveSessionCount)
  const { errors } = report

  // A recent workspace can be a plain folder, e.g. a "No folder" sandbox.
  // It has no lanes, and every git command below would fail with "not a git
  // repository" and put that in front of the user as a sweep error.
  if (
    (await git(repoPath, ['rev-parse', '--is-inside-work-tree'], {
      allowFail: true,
      trim: true,
    })) !== 'true'
  ) {
    return report
  }

  // Dropping registrations for directories that no longer exist is the one
  // action with no downside: it touches git's bookkeeping, never a file.
  try {
    report.prunedRegistrations = (await pruneWorktrees(repoPath)).pruned
  } catch (error) {
    errors.push(`prune: ${String(error)}`)
  }

  let facts: WorktreeFacts[]
  try {
    facts = await gatherFacts(repoPath, true)
  } catch (error) {
    errors.push(`scan: ${String(error)}`)
    return report
  }

  const { candidates, held } = selectReclaimable(facts, {
    protectedPaths,
    now,
    minAgeHours: prefs.minAgeHours,
  })
  report.worktreeCount = facts.length
  report.candidates = candidates
  report.held = held
  report.reclaimableBytes = totalBytes(candidates)

  if (!act) return report

  await reclaimCandidates(report, (_repo, path) =>
    removeCompletedWorktree(
      repoPath,
      path,
      async () => (await gatherFacts(repoPath, false)).find((w) => w.path === path),
      () => ({ protectedPaths: currentProtectedPaths(), now, minAgeHours: prefs.minAgeHours }),
    ),
  )

  log('maintenance', 'sweep complete', {
    repoPath,
    worktrees: report.worktreeCount,
    candidates: candidates.length,
    reclaimed: report.reclaimed.length,
    reclaimedBytes: report.reclaimedBytes,
    errors: errors.length,
  })
  return report
}
