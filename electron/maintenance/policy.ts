import type { ReclaimCandidate, ReclaimHold } from '@shared/models'

/**
 * Everything the policy needs to judge one worktree, gathered by the caller.
 *
 * Pure input on purpose: deciding what to delete is the part that must be
 * exhaustively testable, and it is the part where a wrong answer destroys
 * someone's work. `sweep.ts` does the git and the disk; this file only judges.
 */
export interface WorktreeFacts {
  path: string
  /** Symlink-resolved path — the only form safe to compare on macOS. */
  realPath: string
  branch: string | null
  isMain: boolean
  /** Uncommitted entries, as `git worktree list` porcelain reports them. */
  dirtyCount: number
  /** Proven to be on the trunk, squash-merges included. */
  merged: boolean
  /** Newest mtime found in the tracked tree, ms since epoch. */
  lastWriteMs: number
  /** Disk size in bytes, or null where it could not be measured. */
  bytes: number | null
}

export interface PolicyOptions {
  /**
   * Real paths that must never be reclaimed regardless of git state: live
   * session cwds, the window's open workspace, this app's own checkout.
   */
  protectedPaths: string[]
  now: number
  minAgeHours: number
}

export interface PolicyResult {
  candidates: ReclaimCandidate[]
  /** Everything rejected, with the reason — this is what makes a sweep auditable. */
  held: ReclaimHold[]
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Split worktrees into "safe to delete" and "held, because X".
 *
 * Six independent conditions must ALL hold before a directory is a candidate.
 * They are deliberately redundant — `merged` alone would be enough in theory,
 * but a lane holding uncommitted work that happens to sit on a merged branch
 * is exactly the case where being wrong is unrecoverable.
 */
export function selectReclaimable(
  worktrees: WorktreeFacts[],
  { protectedPaths, now, minAgeHours }: PolicyOptions,
): PolicyResult {
  const protectedSet = new Set(protectedPaths)
  const candidates: ReclaimCandidate[] = []
  const held: ReclaimHold[] = []

  const hold = (w: WorktreeFacts, reason: ReclaimHold['reason']): void => {
    held.push({ path: w.path, branch: w.branch, reason })
  }

  for (const w of worktrees) {
    // The main checkout is the user's actual repo, never a lane.
    if (w.isMain) {
      hold(w, 'main-checkout')
      continue
    }
    // A detached worktree cannot be proven merged, so it is never reclaimed.
    if (!w.branch) {
      hold(w, 'no-branch')
      continue
    }
    // Uncommitted work outranks every other signal.
    if (w.dirtyCount > 0) {
      hold(w, 'dirty')
      continue
    }
    if (protectedSet.has(w.realPath) || protectedSet.has(w.path)) {
      hold(w, 'in-use')
      continue
    }
    if (!w.merged) {
      hold(w, 'unmerged')
      continue
    }
    // A grace period after the last write. A branch can land while its lane is
    // still being read, and reopening a reclaimed lane costs a fresh install.
    if (now - w.lastWriteMs < minAgeHours * HOUR_MS) {
      hold(w, 'too-recent')
      continue
    }
    candidates.push({ path: w.path, branch: w.branch, bytes: w.bytes, reason: 'merged' })
  }

  return { candidates, held }
}

/** Sum of measured sizes; unmeasured entries contribute nothing. */
export function totalBytes(items: { bytes: number | null }[]): number {
  return items.reduce((sum, i) => sum + (i.bytes ?? 0), 0)
}
