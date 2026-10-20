import { handle } from './handle'
import { removeReviewedWorktree } from '../maintenance/removal'
import { withWorkspace } from '../maintenance/history'
import { gitDisplayInfo, gitInfoBatch } from '@phosphor/session-runtime/git/git-info'
import { ghAvailable, ghPrForBranch, ghPrsForRepo } from '../fs/gh-cli'
import { createSessionBaseline, gitStatusMap, restoreFileTo, showFileAt } from '../fs/git-service'
import {
  addWorktree,
  commitAll,
  listBranches,
  listWorktrees,
  mergeBranch,
  pruneWorktrees,
  renameBranch,
  startPoint,
} from '../fs/git-worktrees'
import { checkoutBranch, fetchRepo, pullFastForward, updateFromMain } from '../fs/git-sync'

/** Git status and per-file baseline/restore for the Changes pane. */
export function registerGitHandlers(): void {
  handle('gh:available', () => ghAvailable())

  handle('gh:prForBranch', (_event, repoPath: string, branch: string) =>
    ghPrForBranch(repoPath, branch),
  )

  handle('gh:prsForRepo', (_event, repoPath: string) => ghPrsForRepo(repoPath))

  handle('git:info', (_event, workspacePath, options) => gitDisplayInfo(workspacePath, options))

  handle('git:infoBatch', (_event, cwds: string[]) => gitInfoBatch(cwds))

  handle('git:statusMap', (_event, workspacePath: string) => gitStatusMap(workspacePath))

  handle('git:sessionBaseline', (_event, workspacePath: string) =>
    createSessionBaseline(workspacePath),
  )

  handle('git:showFileAt', (_event, workspacePath, ref, relativePath) =>
    showFileAt(workspacePath, ref, relativePath),
  )

  handle('git:restoreFileTo', (_event, workspacePath, ref, relativePath) =>
    withWorkspace(workspacePath, () => restoreFileTo(workspacePath, ref, relativePath)),
  )

  handle('git:listWorktrees', (_event, repoPath) => listWorktrees(repoPath))

  handle('git:listBranches', (_event, repoPath) => listBranches(repoPath))

  handle('git:startPoint', (_event, repoPath) => startPoint(repoPath))

  handle('git:addWorktree', (_event, repoPath, name, branch) => addWorktree(repoPath, name, branch))

  handle('git:removeWorktree', (_event, repoPath, worktreePath, options) =>
    removeReviewedWorktree(repoPath, worktreePath, options),
  )

  handle('git:renameBranch', (_event, repoPath, from, to) => renameBranch(repoPath, from, to))

  handle('git:pruneWorktrees', (_event, repoPath) => pruneWorktrees(repoPath))

  handle('git:commitAll', (_event, worktreePath, message) =>
    withWorkspace(worktreePath, () => commitAll(worktreePath, message)),
  )

  handle('git:mergeBranch', (_event, repoPath, branch) =>
    withWorkspace(repoPath, () => mergeBranch(repoPath, branch)),
  )

  handle('git:fetch', (_event, repoPath, options) => fetchRepo(repoPath, options))

  handle('git:pull', (_event, cwd) => withWorkspace(cwd, () => pullFastForward(cwd)))

  handle('git:updateFromMain', (_event, worktreePath, mainBranch) =>
    withWorkspace(worktreePath, () => updateFromMain(worktreePath, mainBranch)),
  )

  handle('git:checkoutBranch', (_event, repoPath, branch) =>
    withWorkspace(repoPath, () => checkoutBranch(repoPath, branch)),
  )
}
