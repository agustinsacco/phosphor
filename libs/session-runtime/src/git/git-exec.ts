import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { errorText } from '@shared/errors'
import { gitInfoCache } from './git-info-cache'

const execFileAsync = promisify(execFile)

/**
 * The one `git` runner for machine-local code.
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
  /**
   * Drop every inherited `GIT_*` variable before `env` applies, so `cwd` alone
   * picks the repository (an inherited `GIT_DIR` would otherwise win).
   */
  isolateEnv?: boolean
  /** This call's output cap (default 64 MiB); past it the call throws before more is held. */
  maxBuffer?: number
  /** Optional per-call deadline/cancellation. */
  timeout?: number
  signal?: AbortSignal
  /** Inspect Git diagnostics separately from stdout (e.g. worktree prune dry run). */
  stderr?: (stderr: string) => void
}

export const GIT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 64 * 1024 * 1024

const READ_ONLY = new Set([
  'rev-parse',
  'rev-list',
  'status',
  'diff',
  'show',
  'for-each-ref',
  'merge-base',
  'ls-files',
  'ls-tree',
  'check-ref-format',
  'cat-file',
  // These write unreachable objects, not HEAD, refs, or the working tree.
  'write-tree',
  'commit-tree',
])

/** The subcommand and its arguments, after any leading `-c key=value` overrides. */
function subcommand(args: string[]): string[] {
  let i = 0
  while (args[i] === '-c' && i + 1 < args.length) i += 2
  return args.slice(i)
}

export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const cmd = subcommand(args)
  const readOnly =
    READ_ONLY.has(cmd[0] ?? '') ||
    (cmd[0] === 'worktree' && cmd[1] === 'list') ||
    (cmd[0] === 'remote' && cmd[1] === 'get-url') ||
    (cmd[0] === 'symbolic-ref' && cmd[1] === '--short' && cmd.length === 3) ||
    (Boolean(options.env?.GIT_INDEX_FILE) && ['add', 'read-tree'].includes(cmd[0] ?? ''))
  // Unknown commands conservatively invalidate. Shared refs affect sibling
  // worktrees too, so mutations clear all display entries, before and after.
  if (!readOnly) gitInfoCache.invalidate()
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      signal: options.signal,
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      ...(options.env || options.isolateEnv
        ? {
            env: {
              ...(options.isolateEnv
                ? Object.fromEntries(
                    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
                  )
                : process.env),
              ...options.env,
            },
          }
        : {}),
    })
    options.stderr?.(stderr)
    return options.trim ? stdout.trim() : stdout
  } catch (error) {
    if (options.allowFail) return ''
    throw error
  } finally {
    // Failed mutations can still leave changed state, e.g. a conflicted merge.
    if (!readOnly) gitInfoCache.invalidate()
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
export type GitRunner = typeof git

export async function dirtyCount(cwd: string, run: GitRunner = git): Promise<number> {
  const status = await run(cwd, ['-c', 'core.fsmonitor=false', 'status', '--porcelain'], {
    env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
  })
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
