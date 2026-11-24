import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getLoginShellPath } from '@phosphor/session-runtime/pi/shell-env'

const execFileAsync = promisify(execFile)

/** Bound on one `command -v` run. */
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
export async function resolveBinary(name: string): Promise<string | null> {
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
