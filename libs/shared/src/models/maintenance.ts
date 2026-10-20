/**
 * The periodic janitor. Lanes are cheap to create and nothing ever reclaimed
 * one, so a long-lived install accumulates a worktree (and its own
 * `node_modules`) per lane forever — measured at 9.1 GB across 70 worktrees on
 * one machine, 77% of it duplicated dependencies.
 *
 * Measuring and deleting are separate switches on purpose. A sweep ALWAYS
 * measures; only `reclaimMergedWorktrees` lets it delete, and it ships off.
 */
export interface MaintenancePrefs {
  /** Sweep periodically while the app is running. */
  enabled: boolean
  /** Minutes between sweeps. Clamped to a sane floor by the scheduler. */
  intervalMinutes: number
  /**
   * Delete the worktree of a lane whose branch already landed on the trunk.
   * Off by default: rebuilding a reclaimed lane costs a fresh `npm install`,
   * so this is the user's call, not ours.
   */
  reclaimMergedWorktrees: boolean
  /** Leave a merged lane alone until it has been untouched this long. */
  minAgeHours: number
}

export const DEFAULT_MAINTENANCE_PREFS: MaintenancePrefs = {
  enabled: true,
  intervalMinutes: 60,
  reclaimMergedWorktrees: false,
  minAgeHours: 24,
}

/** Why a worktree was NOT reclaimed. Makes a sweep auditable after the fact. */
export type ReclaimHoldReason =
  | 'main-checkout'
  | 'no-branch'
  | 'dirty'
  | 'in-use'
  | 'unmerged'
  | 'too-recent'
  | 'unfinished'
  | 'locked'
  | 'pinned'

export interface ReclaimHold {
  path: string
  branch: string | null
  reason: ReclaimHoldReason
}

export interface ReclaimCandidate {
  path: string
  branch: string | null
  /** Disk size in bytes, or null where it could not be measured. */
  bytes: number | null
  reason: 'merged'
}

/** One sweep's findings. Produced whether or not anything was deleted. */
export interface MaintenanceReport {
  ranAt: number
  workspacePath: string
  worktreeCount: number
  candidates: ReclaimCandidate[]
  held: ReclaimHold[]
  /** Stale registrations `git worktree prune` dropped — never a real directory. */
  prunedRegistrations: string[]
  /** Directories actually deleted this sweep. Empty unless the pref is on. */
  reclaimed: { path: string; branch: string | null; bytes: number | null }[]
  reclaimableBytes: number
  reclaimedBytes: number
  /** Live `pi --mode rpc` children, each costing roughly 200 MB resident. */
  liveSessionCount: number
  errors: string[]
}
