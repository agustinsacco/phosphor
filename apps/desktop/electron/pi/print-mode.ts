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
import { spawn, type ChildProcess } from 'node:child_process'

/** POSIX only: the child leads its own process group, so the group can die. */
const OWN_GROUP = process.platform !== 'win32'

/**
 * Kill the run and everything it started. pi alone is not enough: a provider
 * or extension can spawn its own children (the Claude CLI, MCP servers), and
 * killing only pi leaves them orphaned. Also called after a clean exit, so
 * nothing a title run started can outlive it. ESRCH (already gone) is fine.
 */
function killTree(child: ChildProcess): void {
  try {
    if (OWN_GROUP && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    // Already exited.
  }
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

/**
 * Run a command that speaks pi's print mode and collect its stdout.
 *
 * Never rejects: every caller of this treats a failure as "no answer", and a
 * thrown error in a fire-and-forget naming pass is just an unhandled rejection.
 */
export async function runPrintMode(
  binaryPath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<PrintModeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
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
      killTree(child)
      resolve(result)
    }

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
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString()
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
