import { basename } from 'node:path'
import { branchNameFor, normalizePrefix } from '@shared/branchName'
import { errorText } from '@shared/errors'
import { gitInfo } from './git-info'
import { addWorktree, listBranches, listWorktrees, startPoint } from './git-worktrees'

/**
 * Where a lane started by the main process should run.
 *
 * A lane is one unit of work: one charter, one branch, one worktree, one agent
 * process. The branch is not a nicety — it is the only thing that makes two
 * lanes safe in one repo. This repo has already had the incident: two agent
 * sessions in one tree, one ran `git add -A && commit` and discarded the rest,
 * and the untracked files were unrecoverable.
 *
 * This exists because that isolation lived **entirely in the renderer**
 * (`src/features/sessions/startChat.ts`), so any main-side caller that passed
 * a bare `workspacePath` to `spawnSession` landed the agent in the main
 * checkout on whatever branch happened to be out.
 *
 * Degrades the way the renderer's path does, and for the same reason: a git
 * refusal must never stop a lane from starting. It returns the original folder
 * with a stated `warning`, and the caller is expected to surface it.
 */

export interface LaneWorkspace {
  /** Where the agent should actually spawn. */
  workspacePath: string
  /** Branch cut for this lane, when one was. */
  branch?: string
  /** Repo of record — the main checkout, for grouping and later merges. */
  repoPath?: string
  /** Non-fatal reason isolation did not happen. Surface it, never swallow it. */
  warning?: string
}

export interface LaneWorkspaceOptions {
  /** Folder the caller asked for. May itself be a worktree. */
  workspacePath: string
  /** Lane title, used for the branch and folder slug. */
  title: string
  /** Configured branch prefix, e.g. `phosphor/`. */
  branchPrefix?: string
}

export async function createLaneWorkspace({
  workspacePath,
  title,
  branchPrefix = '',
}: LaneWorkspaceOptions): Promise<LaneWorkspace> {
  let repoPath: string
  try {
    const info = await gitInfo(workspacePath)
    if (!info.isRepo) {
      return { workspacePath, warning: 'Not a git repository — this lane is not isolated.' }
    }
    // A lane started from inside a worktree still branches off trunk in the
    // main tree: new work, not a continuation of whatever that worktree holds.
    repoPath = info.isWorktree && info.mainRepoPath ? info.mainRepoPath : workspacePath
  } catch (error) {
    return {
      workspacePath,
      warning: `Couldn't read git state — this lane is not isolated. ${errorText(error)}`,
    }
  }

  try {
    const [base, { branches }, worktrees] = await Promise.all([
      startPoint(repoPath),
      listBranches(repoPath),
      listWorktrees(repoPath),
    ])

    const { folder, branch } = branchNameFor({
      title,
      prefix: normalizePrefix(branchPrefix),
      takenBranches: branches.map((b) => b.name),
      takenFolders: worktrees.filter((w) => !w.isMain).map((w) => basename(w.path)),
    })

    const worktree = await addWorktree(repoPath, folder, {
      kind: 'new',
      base: base.base,
      branch,
      // `--no-track` only when branching off a remote-tracking ref: otherwise the
      // new branch takes `origin/main` as upstream and a stray push aims at trunk.
      noTrack: base.fromRemote,
    })

    return { workspacePath: worktree.path, branch, repoPath }
  } catch (error) {
    return {
      workspacePath,
      repoPath,
      warning:
        `Couldn't create a branch for this lane — it is running in ` +
        `${basename(workspacePath)} instead. ${errorText(error)}`,
    }
  }
}
