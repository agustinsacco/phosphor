import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { errorText } from '@shared/errors'

const execFileAsync = promisify(execFile)

/**
 * The one `git` runner for the main process.
 *
 * `git-info`, `git-service`, `git-sync` and `git-worktrees` each used to
 * declare their own, and the limits had drifted to four different values for
 * no stated reason (10s/1MB, 20s/64MB, 30s/16MB, 30s/16MB). The 1MB default in
 * `git-info` was the one that mattered: `git status --porcelain` on a very
 * large dirty tree overflows it and the caller's `catch` swallows that as "no
 * dirty count". One documented pair of limits — the widest of the four —
 * applies everywhere now.
 */

export interface GitOptions {
  /** Return '' instead of throwing when git exits non-zero. */
  allowFail?: boolean
  /**
   * Trim surrounding whitespace off stdout. Explicit rather than the default:
   * single-value queries (`rev-parse`, `symbolic-ref`) want it, line-oriented
   * output usually filters empties itself.
   */
  trim?: boolean
  /**
   * Extra environment for this call only, merged over the inherited env.
   *
   * The reason this exists is `GIT_INDEX_FILE`: the only way to stage into a
   * throwaway index is to point git at one, and it has to be per-call because
   * every other git call in the process must keep using the real index.
   */
  env?: Record<string, string>
}

const TIMEOUT_MS = 30_000
const MAX_BUFFER = 64 * 1024 * 1024

export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    })
    return options.trim ? stdout.trim() : stdout
  } catch (error) {
    if (options.allowFail) return ''
    throw error
  }
}

/**
 * Number of entries in `git status --porcelain`.
 *
 * Trim first, then drop empties: porcelain output ends in a newline, so
 * counting the raw split reports one entry too many, and a clean tree ('')
 * splits to a single empty string rather than nothing. The four hand-rolled
 * versions this replaces each got a different subset of that right.
 */
export async function dirtyCount(cwd: string): Promise<number> {
  const status = await git(cwd, ['status', '--porcelain'])
  return status.trim().split('\n').filter(Boolean).length
}

/**
 * Collect the conflicted paths of a failed merge, then put the tree back.
 *
 * Both calls tolerate failure on purpose: the conflict list is diagnostic
 * only, and `merge --abort` fails when there is no merge in progress (the
 * original failure predated it). Either way Phosphor never leaves a tree
 * mid-merge.
 */
export async function abortMergeAndCollectConflicts(cwd: string): Promise<string[]> {
  const conflicts = (
    await git(cwd, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })
  )
    .split('\n')
    .filter(Boolean)
  await git(cwd, ['merge', '--abort'], { allowFail: true })
  return conflicts
}

/**
 * A git failure as one line fit for a UI slot.
 *
 * `execFile` rejects with `Command failed: git branch -d x\n<stderr>`, and a
 * truncated one-line slot then shows the user the command back rather than the
 * reason. git's own `error:`/`fatal:` line is the part worth reading, and its
 * `hint:` lines are advice for a terminal user, not for this UI.
 */
export function gitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const lines =
    typeof stderr === 'string'
      ? stderr
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : []
  const reason =
    lines.find((line) => line.startsWith('error:') || line.startsWith('fatal:')) ??
    lines.find((line) => !line.startsWith('hint:'))
  if (reason) return reason.replace(/^(error|fatal):\s*/, '')
  return (errorText(error).split('\n')[0] ?? '').trim()
}
