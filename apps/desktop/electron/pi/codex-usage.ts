import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createCodexUsageReader } from '@phosphor/session-runtime/pi/codex-usage'
import { resolvePiInvoker } from './invoker'

const execFileAsync = promisify(execFile)
/** Usage inspection must not refresh a rotating credential: this short-lived process
 * can time out after the server rotates it but before pi saves it. Session pi owns
 * refresh and persistence. A stale access token means unavailable usage, not logout.
 * Never log subprocess errors, tokens or response bodies. */
async function readAuth(): Promise<string> {
  const invoker = await resolvePiInvoker('piProcessEnv-stub')
  const { stdout } = await execFileAsync(
    invoker.binaryPath,
    [
      ...invoker.prefixArgs,
      'auth',
      'check',
      '--provider',
      'openai-codex',
      '--json',
      '--credentials',
      '--no-refresh',
    ],
    {
      env: invoker.env,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    },
  )
  return stdout
}

export const fetchCodexUsage = createCodexUsageReader(readAuth)
