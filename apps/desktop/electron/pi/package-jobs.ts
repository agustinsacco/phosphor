import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killProcessTree, OWN_GROUP, runPrintMode } from './print-mode'

/** Sender surface the runner needs (subset of Electron.WebContents). */
export interface JobSender {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** Generous: a slow install takes minutes. A job still running is hung. */
const PACKAGE_JOB_TIMEOUT_MS = 15 * 60_000
/** How long quit waits for stopped jobs to report before going on. */
const DISPOSE_SETTLE_MS = 3_000
/** What a stopped job reports: a killed child always reported `code ?? 1`. */
const STOPPED_EXIT_CODE = 1
const SHUTTING_DOWN = 'Phosphor is shutting down. New work cannot start.'

/** A running job as disposal sees it: stop it, then wait for its exit. */
const activeJobs = new Map<string, { cancel: (reason: string) => void; settled: Promise<void> }>()
/** Set by disposePackageJobs; from then on every new job is refused. */
let disposal: Promise<void> | null = null

/**
 * Register a job. `output` streams on `packages:output:<jobId>`; `finish`
 * runs `onExit`, then reports on `packages:exit:<jobId>` — once, whichever of
 * exit, error, deadline and `cancel` comes first. Nothing streams after it,
 * and a closed window simply stops receiving.
 */
function trackJob(
  sender: JobSender,
  stop: (reason: string) => void,
  onExit?: (code: number) => void,
): {
  jobId: string
  output: (text: string) => void
  finish: (code: number) => void
  cancel: (reason: string) => void
} {
  const jobId = randomUUID()
  const emit = (channel: string, payload: unknown): void => {
    if (!sender.isDestroyed()) sender.send(channel, payload)
  }
  let finished = false
  let settle = (): void => {}
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const cancel = (reason: string): void => {
    if (!finished) stop(reason)
  }
  activeJobs.set(jobId, { cancel, settled })
  return {
    jobId,
    cancel,
    output: (text) => {
      if (!finished) emit(`packages:output:${jobId}`, text)
    },
    finish: (code) => {
      if (finished) return
      finished = true
      activeJobs.delete(jobId)
      try {
        onExit?.(code)
      } finally {
        emit(`packages:exit:${jobId}`, code)
        settle()
      }
    },
  }
}

/**
 * Spawn a command and stream its output to the renderer on
 * `packages:output:<jobId>` / `packages:exit:<jobId>`. The job leads its own
 * process tree, so its deadline and quit stop whatever it started too.
 */
export function startJob(
  sender: JobSender,
  command: string,
  args: string[],
  options: {
    cwd?: string
    env: Record<string, string>
    /**
     * Runs in main when the job ends, before the renderer hears the exit —
     * so a cache the job made stale is already dropped by the time the UI
     * re-asks. Fires once, for a spawn failure (code 127) and a stop too.
     */
    onExit?: (code: number) => void
  },
): { jobId: string } {
  if (disposal) return failedJob(sender, SHUTTING_DOWN)
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: OWN_GROUP,
  })
  const job = trackJob(
    sender,
    (reason) => {
      job.output(`${reason}\n`)
      killProcessTree(child)
      finish(STOPPED_EXIT_CODE)
    },
    options.onExit,
  )
  const deadline = setTimeout(
    () => job.cancel('Stopped: still running after 15 minutes.'),
    PACKAGE_JOB_TIMEOUT_MS,
  )
  const finish = (code: number): void => {
    clearTimeout(deadline)
    job.finish(code)
  }

  child.stdout?.on('data', (chunk: Buffer) => job.output(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => job.output(chunk.toString()))
  child.on('error', (error) => {
    job.output(`${error.message}\n`)
    finish(127)
  })
  child.on('close', (code) => finish(code ?? 1))

  return { jobId: job.jobId }
}

/**
 * A print-mode run as a streamed job: stdout streams, a failure ends with
 * print mode's reason, and the exit is 0 for a clean answer, else 1. Starts
 * a tick late, like failedJob, because a spawn failure settles at once.
 */
export function startPrintModeJob(
  sender: JobSender,
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): { jobId: string } {
  if (disposal) return failedJob(sender, SHUTTING_DOWN)
  const controller = new AbortController()
  const job = trackJob(sender, (reason) => {
    job.output(`${reason}\n`)
    controller.abort()
  })
  setTimeout(() => {
    void runPrintMode(command, args, {
      ...options,
      signal: controller.signal,
      onStdout: job.output,
    }).then(({ error }) => {
      if (error) job.output(`${error}\n`)
      job.finish(error ? 1 : 0)
    })
  }, 0)
  return { jobId: job.jobId }
}

/**
 * Stop every package job and refuse new ones; approved quit calls this so no
 * job's process tree outlives Phosphor. Idempotent. Resolves once every
 * stopped job has reported, or after DISPOSE_SETTLE_MS.
 */
export function disposePackageJobs(): Promise<void> {
  if (disposal) return disposal
  const stopping = [...activeJobs.values()]
  disposal = new Promise<void>((resolve) => {
    const bound = setTimeout(resolve, DISPOSE_SETTLE_MS)
    void Promise.all(stopping.map((job) => job.settled)).then(() => {
      clearTimeout(bound)
      resolve()
    })
  })
  for (const job of stopping) {
    try {
      job.cancel('Stopped: Phosphor is quitting.')
    } catch (error) {
      // A throwing onExit must not leave the other jobs running. It still
      // surfaces, as it would from a job's own exit.
      queueMicrotask(() => {
        throw error
      })
    }
  }
  return disposal
}

/** Report a spawn-precondition failure through the job channels. */
export function failedJob(sender: JobSender, message: string): { jobId: string } {
  const jobId = randomUUID()
  // Delay so the renderer can subscribe with the returned jobId first.
  setTimeout(() => {
    if (sender.isDestroyed()) return
    sender.send(`packages:output:${jobId}`, `${message}\n`)
    sender.send(`packages:exit:${jobId}`, 127)
  }, 0)
  return { jobId }
}
