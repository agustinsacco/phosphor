import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getLoginShellPath } from './shell-env'
import { pickWhereMatch } from './win-launch'

const execFileAsync = promisify(execFile)

/**
 * Where a binary is, as the shell or `where` reports it. Shared by
 * `resolveBinary` and the pi health probe (health.ts); what to
 * spawn on Windows is each caller's policy, so only `where`'s raw output is
 * shared, never a pick from it.
 */

/** Bound on one `command -v` or `where` run. */
const LOOKUP_TIMEOUT_MS = 15_000

/**
 * The name arrives as `$1`, never as part of this text: whatever it holds
 * (`;`, `$( )`, quotes, spaces) is looked up as one literal name.
 */
const COMMAND_V_SCRIPT = 'command -v "$1"'

/**
 * A binary's path on the login-shell PATH (GUI launches lack it, and a
 * version manager's binaries live there), then on the process PATH (a dev
 * run launched from a terminal). Null when neither has it, or a lookup fails
 * or runs past its bound.
 */
export async function lookupPosixBinary(name: string): Promise<string | null> {
  const shellPath = await getLoginShellPath()
  const envs: NodeJS.ProcessEnv[] = shellPath ? [{ ...process.env, PATH: shellPath }] : []
  envs.push({ ...process.env })
  for (const env of envs) {
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', COMMAND_V_SCRIPT, 'sh', name], {
        timeout: LOOKUP_TIMEOUT_MS,
        env,
      })
      // The last line: anything before it is shell chatter, not the answer.
      const found = stdout.trim().split('\n').pop()?.trim()
      if (found) return found
    } catch {
      // Not found here (`command -v` exits 1), or the lookup failed: next PATH.
    }
  }
  return null
}

/**
 * `where <name>`'s stdout as printed (every PATH hit, CRLF-separated), or ''
 * when it finds nothing or fails. Windows only; a GUI process inherits the
 * user's PATH there, so there is no login shell to consult.
 */
export async function windowsWhereOutput(name: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('where', [name], { timeout: LOOKUP_TIMEOUT_MS })
    return stdout
  } catch {
    return ''
  }
}

/** Resolve a binary on the login-shell PATH (GUI launches lack it). */
export async function resolveBinary(name: string): Promise<string | null> {
  // Not the first `where` line on Windows: for an npm-installed CLI that is
  // the POSIX sh shim, which nothing on Windows can run. A `.exe` is
  // spawnable; a `.cmd` is returned as found and fails at spawn (EINVAL) — pi
  // itself never comes through here (see resolvePiInvoker), and the callers
  // that do (claude, npm, uv, pipx, headroom) mostly ship real executables.
  if (process.platform === 'win32') return pickWhereMatch(await windowsWhereOutput(name))
  return lookupPosixBinary(name)
}
