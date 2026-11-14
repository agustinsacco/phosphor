import { useSessionsStore } from './sessions'
import type { LaneRemovalOptions, LaneRemovalTarget } from './laneRemovalState'

/** Legacy permanent removal only. Archive never enters worktree destruction. */
export async function removeLaneWorktree(
  lane: LaneRemovalTarget,
  options: LaneRemovalOptions,
): Promise<string | undefined> {
  let branchError: string | undefined
  if (!options.archive && options.removeWorktree && lane.worktreePath && lane.mainRepoPath) {
    // Stop every writer, including handles a renderer reload has not
    // adopted yet, before removing its working directory.
    const mainLive = await window.phosphor.invoke('pi:listLiveSessions')
    const ids = new Set([
      ...Object.values(useSessionsStore.getState().live)
        .filter((l) => l.diskPath === lane.path)
        .map((l) => l.phosphorId),
      ...(mainLive ?? []).filter((l) => l.diskPath === lane.path).map((l) => l.sessionId),
    ])
    for (const id of ids) await useSessionsStore.getState().disposeSession(id)
    const { useWorktreesStore } = await import('./worktrees')
    const outcome = await useWorktreesStore
      .getState()
      .removeWorktree(lane.mainRepoPath, lane.worktreePath, {
        force: options.discardChanges,
        deleteBranch: options.deleteBranch,
      })
    if (!outcome.removed) {
      throw new Error(`worktree kept, ${outcome.dirtyCount} uncommitted changes`)
    }
    branchError = outcome.branchError
  }
  return branchError
}
