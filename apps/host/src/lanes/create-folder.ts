import { isLaneBranchName, type LaneCreatePhase } from '@phosphor/shared/host-protocol'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { RepositoryLocks } from './repository-lock'
import { LaneFolderError, laneFolderSlug, prepareLaneFolder, type LaneFolder } from './worktree'

type WorktreeRequest = { readonly branch: string; readonly fresh?: true }

/** The suffixes a fresh branch tries, in order, after its requested name exists. */
const FRESH_BRANCH_SUFFIXES = [2, 3, 4, 5] as const

/**
 * The names a fresh branch falls back to: `<branch>-2` to `<branch>-5`. The base is
 * cut so the name still has a worktree folder, and loses trailing dashes, dots and
 * slashes before the suffix. A name that is still not a valid branch is skipped.
 */
export function freshBranchCandidates(branch: string): string[] {
  const names: string[] = []
  for (const n of FRESH_BRANCH_SUFFIXES) {
    const suffix = `-${n}`
    const name = `${branch.slice(0, 100 - suffix.length).replace(/[-./]+$/, '')}${suffix}`
    if (isLaneBranchName(name) && laneFolderSlug(name) !== null && !names.includes(name))
      names.push(name)
  }
  return names
}

/** A fresh branch whose name exists retries under the next free candidate. */
async function prepareWorktree(
  root: string,
  worktree: WorktreeRequest,
  log: RuntimeLog | undefined,
): Promise<LaneFolder> {
  if (!worktree.fresh) return prepareLaneFolder({ root, worktree, log })
  let refusal: unknown
  for (const branch of [worktree.branch, ...freshBranchCandidates(worktree.branch)]) {
    try {
      return await prepareLaneFolder({ root, worktree: { branch, fresh: true }, log })
    } catch (error) {
      if (!(error instanceof LaneFolderError && error.code === 'branch-exists')) throw error
      refusal = error
    }
  }
  throw refusal
}

/**
 * A lane's folder. Worktree work, and its undo, runs under the repository's lock;
 * a lane in place only reads git and never waits. `phase` reports `queued` when the
 * lock is busy, then `branching` once the folder work starts.
 */
export async function prepareCreationFolder(input: {
  root: string
  worktree: WorktreeRequest | null
  locks: RepositoryLocks
  phase: (phase: LaneCreatePhase) => void
  log?: RuntimeLog
}): Promise<LaneFolder> {
  const { root, worktree, locks, phase, log } = input
  if (worktree === null) return prepareLaneFolder({ root, worktree, log })
  const folder = await locks.run(
    root,
    () => {
      phase('branching')
      return prepareWorktree(root, worktree, log)
    },
    () => phase('queued'),
  )
  return { ...folder, undo: () => locks.run(root, folder.undo) }
}
