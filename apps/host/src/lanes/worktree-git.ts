import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { GIT_TIMEOUT_MS, git } from '@phosphor/session-runtime/git/git-exec'
import { WORKTREE_GIT_TIMEOUT } from '@phosphor/shared/errors'

const ADD_TIMEOUT_MS = 90_000
const PREPARE_TIMEOUT_MS = 95_000
export const FAILED_CLEANUP_MS = 10_000

export class LaneFolderError extends Error {
  constructor(
    message: string,
    readonly code?: 'branch-exists',
  ) {
    super(message)
  }
}

export const worktreeGitDeadline = () => performance.now() + PREPARE_TIMEOUT_MS

/** Renders a bounded stderr suffix, using only known Git diagnostics. A checkout can
 * invoke hooks or filters; their arbitrary output cannot safely be logged verbatim. */
function safeStderrTail(stderr: string): string {
  return [
    ...new Set(
      stderr
        .slice(-2048)
        .trimEnd()
        .split(/[\r\n]+/)
        .map(safeDiagnostic),
    ),
  ].join('\n')
}

function safeDiagnostic(line: string): string {
  const fsFailure =
    /^(fatal: cannot create (?:directory|leading directories)|error: unable to (?:create|write) file) .*: (Permission denied|No space left on device|Read-only file system|File exists)$/.exec(
      line,
    )
  if (fsFailure) return `${fsFailure[1]}: ${fsFailure[2]}`
  if (/^fatal: .* is already checked out at /.test(line)) return 'fatal: branch already checked out'
  if (/^fatal: .* already exists$/.test(line)) return 'fatal: destination already exists'
  if (/^fatal: invalid reference: /.test(line)) return 'fatal: invalid reference'
  if (/^fatal: not a git repository\b/.test(line)) return 'fatal: not a git repository'
  if (/^fatal: detected dubious ownership in repository at /.test(line))
    return 'fatal: detected dubious ownership in repository'
  if (/^Preparing worktree \(/.test(line)) return 'Preparing worktree'
  return '[unrecognized stderr omitted]'
}

export function worktreeGit(root: string, deadline?: number, log?: RuntimeLog) {
  // `resolveDefaultBranch` may ignore optional symbolic-ref errors. A timeout
  // still ends preparation; the next attempt rethrows it before running Git.
  let timeoutError: LaneFolderError | undefined
  let addKilled = false
  const run = async (args: string[], expectedExit?: number): Promise<string> => {
    if (timeoutError) throw timeoutError
    const add = args[0] === 'worktree' && args[1] === 'add'
    const left = deadline === undefined ? Infinity : Math.ceil(deadline - performance.now())
    const timeout = Math.min(add ? ADD_TIMEOUT_MS : GIT_TIMEOUT_MS, left)
    try {
      if (timeout <= 0) throw new LaneFolderError(WORKTREE_GIT_TIMEOUT)
      return await git(root, args, {
        env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        trim: true,
        timeout,
      })
    } catch (error) {
      const failure = error as {
        code?: unknown
        killed?: unknown
        signal?: unknown
        stderr?: unknown
      } | null
      const code = failure?.code
      const timedOut =
        timeout <= 0 || (code === null && failure?.killed === true && failure.signal === 'SIGTERM')
      if (timedOut) timeoutError = new LaneFolderError(WORKTREE_GIT_TIMEOUT)
      if (timedOut && add && timeout > 0) addKilled = true
      if (timedOut || expectedExit === undefined || code !== expectedExit) {
        // All call sites supply literal subcommands; never log refs, paths, or the Error itself.
        const command = args[0] === 'worktree' ? `git worktree ${args[1]}` : `git ${args[0]}`
        const stderr = typeof failure?.stderr === 'string' ? failure.stderr : ''
        try {
          log?.('host', 'lane.worktree_git_failed', {
            command,
            ...(timedOut ? { timeout: true } : typeof code === 'number' ? { exitCode: code } : {}),
            ...(typeof code === 'string' &&
            /^(?:ENOENT|EACCES|EAGAIN|EMFILE|ENFILE|ENOMEM|ERR_CHILD_PROCESS_STDIO_MAXBUFFER)$/.test(
              code,
            )
              ? { code }
              : {}),
            ...(stderr ? { stderrTail: safeStderrTail(stderr) } : {}),
          })
        } catch {
          // Logging cannot replace the original error.
        }
      }
      throw timeoutError ?? error
    }
  }
  /** A timeout killed `git worktree add` after it started: it may have left a half-made worktree. */
  return Object.assign(run, { addKilled: () => addKilled })
}
