export interface LaneRemovalOptions {
  removeWorktree: boolean
  deleteBranch: boolean
  discardChanges: boolean
  archive?: boolean
}
export interface LaneRemovalTarget {
  path: string
  title: string
  worktreePath?: string
  mainRepoPath?: string
}

export interface LaneDeleteResult {
  path: string
  title: string
  ok: boolean
  /** Set on failure, and also on success when the branch could not be removed. */
  error?: string
}

export interface BulkDeleteProgress {
  archiving?: boolean
  total: number
  done: number
  /** Lane currently being deleted; empty once finished. */
  current: string
  /** Session path of the current lane, so duplicate titles remain unambiguous. */
  currentPath: string
  /**
   * Every selected lane, in run order, published up front.
   *
   * The progress surface used to render only finished rows, so it grew by a
   * row every time a lane completed. Knowing the full list on the first frame
   * lets the expanded notification reserve its final height and fill rows in
   * place.
   */
  lanes: Array<{ path: string; title: string }>
  results: LaneDeleteResult[]
  running: boolean
  cancelled: boolean
}

/** Whether a sidebar lane must be inert while the bulk-delete loop owns it. */
export function laneIsBeingDeleted(progress: BulkDeleteProgress | null, path: string): boolean {
  if (!progress?.running || !progress.lanes.some((lane) => lane.path === path)) return false
  const result = progress.results.find((item) => item.path === path)
  // A successful row may remain in the last disk snapshot until the final
  // refresh. A failed lane is safe to use again immediately.
  if (result) return result.ok
  // Stop skips queued lanes, but the current lane still finishes atomically.
  return !progress.cancelled || progress.currentPath === path
}
