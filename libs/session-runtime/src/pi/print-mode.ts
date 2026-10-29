import { execFile, spawn, type ChildProcess } from 'node:child_process'

/** POSIX children lead a group so providers and extensions are cleaned up too. */
export const OWN_GROUP = process.platform !== 'win32'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 1024 * 1024

/** Windows must not walk a stale pid after exit; taskkill itself is bounded. */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (OWN_GROUP) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  execFile(
    'taskkill',
    ['/pid', String(child.pid), '/T', '/F'],
    { timeout: 5_000, windowsHide: true },
    (error) => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
  )
}

export type PrintModeFailure = 'spawn' | 'exit' | 'timeout' | 'aborted' | 'overflow'

export interface PrintModeResult {
  /** Desktop keeps partial output on timeout/abort, but drops it on failed exit. */
  stdout: string
  error?: string
  reason?: PrintModeFailure
}

export interface PrintModeOptions {
  cwd: string
  /** Supplied by the caller; this transport never assembles or inherits an env. */
  env: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  /** Uncapped streaming, until completion, even when capture has reached its cap. */
  onStdout?: (chunk: string) => void
  /** Desktop defaults to bounded diagnostic capture; Host uses ignore. */
  stderr?: 'capture' | 'ignore'
  maxOutputBytes?: number
  /** Host uses fail with 4096 bytes; Desktop retains its soft chunk-boundary cap. */
  overflow?: 'truncate' | 'fail'
  /** Nonzero exits whose stdout is still the answer, like `pi mcp list` with a server down. */
  reportExitCodes?: readonly number[]
}

interface PrintRun {
  child: ChildProcess
  options: PrintModeOptions
  resolve(result: PrintModeResult): void
  stdout: string
  stderr: string
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  abort(): void
}

function finish(run: PrintRun, result: PrintModeResult): void {
  if (run.settled) return
  run.settled = true
  clearTimeout(run.timer)
  run.options.signal?.removeEventListener('abort', run.abort)
  killProcessTree(run.child)
  run.resolve(result)
}

function captureStdout(run: PrintRun, chunk: Buffer): void {
  if (run.settled) return
  const limit = run.options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const text = chunk.toString()
  if (run.options.overflow === 'fail') {
    // Count bytes, not UTF-16 characters, including split UTF-8 replacements.
    const size = Buffer.byteLength(run.stdout) + chunk.length
    if (size > limit) {
      finish(run, { stdout: '', error: `stdout exceeded ${limit} bytes`, reason: 'overflow' })
      return
    }
    run.stdout += text
  } else if (run.stdout.length < limit) {
    // Preserve Desktop's historical soft cap: the last chunk can cross it.
    run.stdout += text
  }
  run.options.onStdout?.(text)
}

function observe(run: PrintRun): void {
  const timeoutMs = run.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  run.timer = setTimeout(() => {
    finish(run, {
      stdout: run.stdout,
      error: `timed out after ${timeoutMs}ms`,
      reason: 'timeout',
    })
  }, timeoutMs)
  run.child.stdout?.on('data', (chunk: Buffer) => captureStdout(run, chunk))
  run.child.stderr?.on('data', (chunk: Buffer) => {
    if (!run.settled && run.stderr.length < MAX_OUTPUT_BYTES) run.stderr += chunk.toString()
  })
  run.child.on('error', (error) => {
    finish(run, { stdout: '', error: error.message, reason: 'spawn' })
  })
  // exit may precede the last stdout data; only close guarantees drainage.
  run.child.on('close', (code) => {
    finish(
      run,
      code === 0 || (code !== null && run.options.reportExitCodes?.includes(code))
        ? { stdout: run.stdout }
        : {
            stdout: '',
            error: `exited ${code}${run.stderr ? `: ${run.stderr.trim()}` : ''}`,
            reason: 'exit',
          },
    )
  })
  run.options.signal?.addEventListener('abort', run.abort, { once: true })
  if (run.options.signal?.aborted) run.abort()
}

/**
 * Spawn, never exec/execFile: pi -p waits for stdin EOF. Ignore stdin so a
 * provider can answer. Never rejects; completion always cleans up the tree.
 * Title sanitizing, provider env and timeout/overflow result policies stay in callers.
 */
export async function runPrintMode(
  binaryPath: string,
  args: string[],
  options: PrintModeOptions,
): Promise<PrintModeResult> {
  if (options.signal?.aborted) return { stdout: '', error: 'aborted', reason: 'aborted' }
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(binaryPath, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', options.stderr === 'ignore' ? 'ignore' : 'pipe'],
        detached: OWN_GROUP,
      })
    } catch (error) {
      resolve({ stdout: '', error: `spawn failed: ${String(error)}`, reason: 'spawn' })
      return
    }
    const run: PrintRun = {
      child,
      options,
      resolve,
      stdout: '',
      stderr: '',
      settled: false,
      abort() {
        finish(run, { stdout: run.stdout, error: 'aborted', reason: 'aborted' })
      },
    }
    observe(run)
  })
}
