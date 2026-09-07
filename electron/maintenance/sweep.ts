import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { MaintenancePrefs, MaintenanceReport } from '@shared/models'
import { isBranchMerged, listWorktrees, pruneWorktrees, removeWorktree } from '../fs/git-worktrees'
import { sessionDirForCwd } from '../pi/pi-paths'
import { log } from '../debug-log'
import { selectReclaimable, totalBytes, type WorktreeFacts } from './policy'

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

async function gatherFacts(repoPath: string, measure: boolean): Promise<WorktreeFacts[]> {
  const worktrees = await listWorktrees(repoPath)
  return Promise.all(
    worktrees.map(async (w) => ({
      path: w.path,
      realPath: w.realPath,
      branch: w.branch,
      isMain: w.isMain,
      // A missing directory reports −1; treat it as clean so the stale
      // registration can be pruned, not as dirty work worth protecting.
      dirtyCount: Math.max(0, w.dirtyCount),
      merged: w.isMain || !w.branch ? false : await isBranchMerged(repoPath, w.branch),
      lastWriteMs: await lastWrite(w.path),
      bytes: measure ? await directorySize(w.path) : null,
    })),
  )
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
}: SweepOptions): Promise<MaintenanceReport> {
  const errors: string[] = []
  const report: MaintenanceReport = {
    ranAt: now,
    workspacePath: repoPath,
    worktreeCount: 0,
    candidates: [],
    held: [],
    prunedRegistrations: [],
    reclaimed: [],
    reclaimableBytes: 0,
    reclaimedBytes: 0,
    liveSessionCount,
    errors,
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

  for (const candidate of candidates) {
    try {
      const result = await removeWorktree(repoPath, candidate.path, { deleteBranch: true })
      if (!result.removed) {
        // Raced with an edit between the scan and now. Leave it.
        errors.push(`${candidate.path}: became dirty (${result.dirtyCount})`)
        continue
      }
      report.reclaimed.push({
        path: candidate.path,
        branch: candidate.branch,
        bytes: candidate.bytes,
      })
      if (result.branchError) errors.push(`${candidate.branch}: ${result.branchError}`)
    } catch (error) {
      errors.push(`${candidate.path}: ${String(error)}`)
    }
  }
  report.reclaimedBytes = totalBytes(report.reclaimed)

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
