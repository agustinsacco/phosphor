import { realpathSync } from 'node:fs'
import type { WorktreeInfo } from '@phosphor/shared/models'
import { git, type GitRunner } from './git-exec'
/**
 * Resolve symlinks the way pi does (`realpathSync.native`) so worktree paths
 * compare equal to session cwds.
 */
export function normalizeRealPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Parse `git worktree list --porcelain` output. Exported pure for tests. */
export function parseWorktreeList(
  output: string,
): Array<Pick<WorktreeInfo, 'path' | 'branch' | 'head' | 'locked' | 'prunable'>> {
  const result: Array<Pick<WorktreeInfo, 'path' | 'branch' | 'head' | 'locked' | 'prunable'>> = []
  let current: {
    path?: string
    branch: string | null
    head: string
    locked: boolean
    prunable: boolean
  } | null = null
  const flush = (): void => {
    if (current?.path) {
      result.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        locked: current.locked,
        prunable: current.prunable,
      })
    }
    current = null
  }
  for (const line of output.split(output.includes('\0') ? '\0' : '\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice(9), branch: null, head: '', locked: false, prunable: false }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
    } else if (line === 'detached') {
      current.branch = null
    }
  }
  flush()
  return result
}

export async function listWorktreeMetadata(
  repoPath: string,
  run: GitRunner = git,
): Promise<WorktreeInfo[]> {
  const parsed = parseWorktreeList(await run(repoPath, ['worktree', 'list', '--porcelain', '-z']))
  return parsed.map((wt) => ({
    ...wt,
    realPath: normalizeRealPath(wt.path),
    isMain: wt.path === parsed[0]?.path,
    dirtyCount: -1,
  }))
}
