/**
 * One-shot `pi -p` runs (print mode), spawned so that pi can actually finish.
 *
 * **`pi -p` waits for stdin to reach EOF.** That is the whole reason this
 * module exists. It was previously run through `execFile`, which hands the
 * child an open stdin pipe and never closes it, so pi sat idle until the call
 * timed out — silently, with empty stdout and empty stderr. Session
 * auto-naming is the only caller, so no Phosphor session was ever auto-named and
 * every auto-created branch kept the slug of its first message. Measured on
 * the machine that reported it: identical argv, `execFile` timed out at 30s,
 * `spawn` with `stdio[0] = 'ignore'` answered in 8.8s.
 *
 * Nothing here may go back to `execFile`/`exec`. Both leave stdin open.
 *
 * The e2e stub cannot catch a regression: it prints and exits without ever
 * reading stdin, so it is happy either way. `print-mode.test.ts`
 * uses a fixture that blocks on stdin the way real pi does.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'

/** POSIX only: the child leads its own process group, so the group can die. */
export const OWN_GROUP = process.platform !== 'win32'

/** How long a Windows `taskkill` may take before the child alone is killed. */
const TASKKILL_TIMEOUT_MS = 5_000

/**
 * Kill a child and everything it started. The child alone is not enough: a
 * provider or extension can spawn its own children (the Claude CLI, MCP
 * servers), and killing only pi leaves them orphaned. ESRCH (already gone) is
 * fine.
 *
 * POSIX: the child must have been spawned `detached: OWN_GROUP`, so it leads
 * its own group and the group can be killed even after the child itself has
 * exited — which is why print mode calls this after a clean exit too.
 * Windows has no groups: `taskkill /T /F` walks the tree, bounded, falling
 * back to the child alone. It is skipped once the child has exited, because
 * Windows reuses pids and a tree walk from a stale one could kill a stranger.
 */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (OWN_GROUP) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already exited.
    }
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  execFile(
    'taskkill',
    ['/pid', String(child.pid), '/T', '/F'],
    { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
    (error) => {
      if (error && child.exitCode === null) child.kill('SIGKILL')
    },
  )
}

/** Stop waiting on a print-mode run. Generous: it is off any critical path. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Cap captured stdout; a title is a line, anything larger is a malfunction. */
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface PrintModeResult {
  /**
   * Collected stdout. Empty when the run failed BEFORE printing — but a
   * timeout keeps whatever arrived, so `stdout` and `error` can both be set.
   * A caller that treats any error as "no answer" is still correct; one that
   * can use a partial answer should read `stdout` first.
   */
  stdout: string
  /** Why it failed, or undefined on a clean exit 0. */
  error?: string
}

export interface PrintModeOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
  /**
   * Stops the run like a timeout does, with error `aborted`: the tree is
   * killed and stdout so far is kept. Already aborted means nothing spawns.
   */
  signal?: AbortSignal
  /** Each stdout chunk as it arrives, uncapped, until the run settles. */
  onStdout?: (chunk: string) => void
}

/**
 * Run a command that speaks pi's print mode and collect its stdout.
 *
 * Never rejects: every caller of this treats a failure as "no answer", and a
 * thrown error in a fire-and-forget naming pass is just an unhandled rejection.
 * Settles once, whichever of exit, spawn error, timeout or abort comes first.
 */
export async function runPrintMode(
  binaryPath: string,
  args: string[],
  options: PrintModeOptions,
): Promise<PrintModeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { signal } = options
  if (signal?.aborted) return { stdout: '', error: 'aborted' }
  return new Promise<PrintModeResult>((resolve) => {
    let child
    try {
      child = spawn(binaryPath, args, {
        cwd: options.cwd,
        env: options.env,
        // stdin ignored, not piped — see the module comment. This single
        // element is the fix.
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: OWN_GROUP,
      })
    } catch (error) {
      resolve({ stdout: '', error: `spawn failed: ${String(error)}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: PrintModeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      killProcessTree(child)
      resolve(result)
    }
    const onAbort = (): void => finish({ stdout, error: 'aborted' })
    signal?.addEventListener('abort', onAbort, { once: true })

    // Answering and exiting are two different events, and a print-mode run
    // can do the first without the second: pi-claude-cli >= 0.7.0 parks its
    // CLI child after `result`, which holds pi's event loop open long past
    // the answer. Discarding the stdout we already have would throw away a
    // complete title because the process was slow to die. The kill still
    // happens; only the verdict changes.
    const timer = setTimeout(() => {
      finish({ stdout, error: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += text
      if (!settled) options.onStdout?.(text)
    })
    // Kept only to explain a failure. pi is quiet here on success.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ stdout: '', error: error.message }))
    child.on('close', (code) => {
      if (code === 0) {
        finish({ stdout })
        return
      }
      finish({ stdout: '', error: `exited ${code}${stderr ? `: ${stderr.trim()}` : ''}` })
    })
  })
}
