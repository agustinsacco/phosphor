import { readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { branchNameFor } from '@shared/branchName'
import type { LaneWorktreeRequest, LaneWorktreeResult } from '@shared/models'
import { git, gitErrorText } from '@phosphor/session-runtime/git/git-exec'
import { normalizeRealPath } from '@phosphor/session-runtime/git/worktree-metadata'
import { createWorktree, startPoint, worktreeRootFor } from './git-worktrees'
import { log } from '../debug-log'

/**
 * A new lane's worktree, in one main-process call.
 *
 * The renderer used to assemble this from `git:info`, two full worktree
 * listings and `git:addWorktree`. A full listing runs `git status` in every
 * checkout, and archived lanes keep theirs, so a repository with a hundred
 * lanes spent 4 to 12 seconds on dirty counts nobody reads before pi could
 * even spawn. Naming needs only branch names and the folders under
 * `.phosphor/worktrees`, and a just-created checkout is clean by definition.
 *
 * Every refusal is a result, not a throw, so the git reason reaches the
 * composer's warning intact rather than wrapped in an IPC error.
 */
export async function createLaneWorktree(
  workspacePath: string,
  request: LaneWorktreeRequest,
): Promise<LaneWorktreeResult> {
  const started = performance.now()
  const repoPath = await laneRepository(workspacePath)
  if (!repoPath) return { kind: 'unisolated' }

  const [point, branches, folders] = await Promise.all([
    startPoint(repoPath).catch(() => ({ base: 'HEAD', fromRemote: false })),
    git(repoPath, ['for-each-ref', 'refs/heads', '--format=%(refname:short)'])
      .then((out) => out.split('\n').filter(Boolean))
      .catch(() => []),
    readdir(worktreeRootFor(repoPath)).catch(() => []),
  ])
  const { folder, branch } = branchNameFor({
    title: request.title,
    prefix: request.prefix,
    maxSlug: request.maxSlug,
    takenBranches: branches,
    takenFolders: folders,
  })

  try {
    const path = await createWorktree(repoPath, folder, {
      kind: 'new',
      base: point.base,
      branch,
      noTrack: point.fromRemote,
    })
    const head = await git(path, ['rev-parse', 'HEAD'], { trim: true }).catch(() => '')
    log('lanes', 'worktree created', { ms: Math.round(performance.now() - started) })
    return {
      kind: 'created',
      repoPath,
      worktree: {
        path,
        realPath: normalizeRealPath(path),
        branch,
        head,
        isMain: false,
        locked: false,
        prunable: false,
        dirtyCount: 0,
      },
    }
  } catch (error) {
    return { kind: 'failed', repoPath, branch, error: gitErrorText(error) }
  }
}

/**
 * The repository a new lane branches in: a linked worktree's main tree, else
 * the folder itself. Null outside git and on an unborn HEAD, the two cases
 * `git:info` reports as not a repository.
 */
async function laneRepository(workspacePath: string): Promise<string | null> {
  try {
    const out = await git(
      workspacePath,
      ['rev-parse', '--abbrev-ref', 'HEAD', '--absolute-git-dir', '--git-common-dir'],
      { trim: true },
    )
    const [, gitDir, commonDirRaw] = out.split('\n').map((line) => line.trim())
    const commonDir = commonDirRaw ? resolve(workspacePath, commonDirRaw) : undefined
    return gitDir && commonDir && gitDir !== commonDir ? dirname(commonDir) : workspacePath
  } catch {
    return null
  }
}
