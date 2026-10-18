import type { MaintenanceReport } from '@shared/models'
import type { removeWorktree } from '../fs/git-worktrees'
import { totalBytes } from './policy'

export function initializeReport(
  repoPath: string,
  now: number,
  liveSessionCount: number,
): MaintenanceReport {
  return {
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
    errors: [],
  }
}

export async function reclaimCandidates(
  report: MaintenanceReport,
  remove: typeof removeWorktree,
): Promise<void> {
  for (const candidate of report.candidates) {
    try {
      const result = await remove(report.workspacePath, candidate.path, { deleteBranch: true })
      if (!result.removed) {
        // Raced with an edit between the scan and now. Leave it.
        report.errors.push(`${candidate.path}: became dirty (${result.dirtyCount})`)
        continue
      }
      report.reclaimed.push({
        path: candidate.path,
        branch: candidate.branch,
        bytes: candidate.bytes,
      })
      if (result.branchError) report.errors.push(`${candidate.branch}: ${result.branchError}`)
    } catch (error) {
      report.errors.push(`${candidate.path}: ${String(error)}`)
    }
  }
  report.reclaimedBytes = totalBytes(report.reclaimed)
}
