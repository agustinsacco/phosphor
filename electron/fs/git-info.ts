import { dirname, resolve } from 'node:path'
import type { GitInfo } from '@shared/models'
import { dirtyCount, git } from './git-exec'
import { gitInfoCache } from './git-info-cache'

/**
 * Detect a linked worktree from one `rev-parse` call: for a worktree the
 * git-dir lives under `<main>/.git/worktrees/<name>` while the common dir is
 * the main repo's `.git`. Returns undefined outside a repo.
 */
async function worktreeInfo(
  cwd: string,
): Promise<{ isWorktree: boolean; mainRepoPath?: string } | undefined> {
  try {
    const out = await git(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir'], {
      trim: true,
    })
    const [gitDir, commonDirRaw] = out.split('\n').map((l) => l.trim())
    if (!gitDir || !commonDirRaw) return undefined
    // --git-common-dir may be relative (".git" at the repo root).
    const commonDir = resolve(cwd, commonDirRaw)
    if (gitDir === commonDir) return { isWorktree: false }
    return { isWorktree: true, mainRepoPath: dirname(commonDir) }
  } catch {
    return undefined
  }
}

export async function gitInfo(workspacePath: string): Promise<GitInfo> {
  try {
    const branch = await git(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'], { trim: true })
    const info: GitInfo = { isRepo: true, branch }

    const wt = await worktreeInfo(workspacePath)
    if (wt) {
      info.isWorktree = wt.isWorktree
      if (wt.mainRepoPath) info.mainRepoPath = wt.mainRepoPath
    }

    try {
      info.dirtyCount = await dirtyCount(workspacePath)
    } catch {
      // ignore
    }

    try {
      const counts = await git(
        workspacePath,
        ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        { trim: true },
      )
      const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10))
      // `|| 0`, not `?? 0`: parseInt returns NaN (not undefined) on unexpected
      // output, and `??` passes NaN straight through — it then crosses IPC and
      // renders as "NaN behind". The twin in git-sync.ts always had this right.
      info.behind = behind || 0
      info.ahead = ahead || 0
    } catch {
      // no upstream — fine
    }

    return info
  } catch {
    return { isRepo: false }
  }
}

/** Display queries only: routine preflight and lane setup use fresh gitInfo. */
export function gitDisplayInfo(workspacePath: string): Promise<GitInfo> {
  return gitInfoCache.get(workspacePath, 'full', gitInfo)
}

// ---------- batched, cached summaries for the sidebar ----------

/**
 * Cheap per-cwd summary for sidebar rows: branch, worktree flag, dirty count.
 * Skips ahead/behind (an extra rev-list per cwd that rows don't show).
 */
async function gitSummary(cwd: string): Promise<GitInfo> {
  try {
    const out = await git(
      cwd,
      ['rev-parse', '--abbrev-ref', 'HEAD', '--absolute-git-dir', '--git-common-dir'],
      { trim: true },
    )
    const [branch, gitDir, commonDirRaw] = out.split('\n').map((l) => l.trim())
    const info: GitInfo = { isRepo: true, branch }
    const commonDir = commonDirRaw ? resolve(cwd, commonDirRaw) : undefined
    if (gitDir && commonDir && gitDir !== commonDir) {
      info.isWorktree = true
      info.mainRepoPath = dirname(commonDir)
    } else {
      info.isWorktree = false
    }
    try {
      info.dirtyCount = await dirtyCount(cwd)
    } catch {
      // ignore
    }
    return info
  } catch {
    return { isRepo: false }
  }
}

/**
 * Batch git summaries with a short TTL cache and in-flight dedupe. Sidebar
 * rows share cwds (sessions group by folder), so a large sidebar resolves to
 * a handful of actual git invocations. The cache caps display queries at four
 * concurrent across all batches and full-info callers, not four per batch.
 */
export async function gitInfoBatch(cwds: string[]): Promise<Record<string, GitInfo>> {
  const unique = [...new Set(cwds)].filter(Boolean)
  const result: Record<string, GitInfo> = {}
  const queue = [...unique]
  const worker = async (): Promise<void> => {
    for (let cwd = queue.shift(); cwd !== undefined; cwd = queue.shift()) {
      result[cwd] = await gitInfoCache.get(cwd, 'summary', gitSummary)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker))
  return result
}
