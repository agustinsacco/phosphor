import { spawn, type ChildProcess } from 'node:child_process'
import { MCP_SERVER_NAME } from '@phosphor/shared/mcp'
import { parseMcpInspection, type McpInspection } from '@phosphor/shared/mcp-inspection'
import { killProcessTree, OWN_GROUP, runPrintMode, type PrintModeResult } from './print-mode'

export interface McpInspectorCli {
  binaryPath: string
  prefixArgs?: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}
export type InspectionResult =
  { ok: true; report: McpInspection } | { ok: false; message: string; unsupported?: boolean }
interface Job {
  cli: McpInspectorCli
  name: string
  signal: AbortSignal
  resolve: (result: InspectionResult) => void
  settled: boolean
  child?: ChildProcess
  closed?: Promise<void>
  didClose?: () => void
  abort: () => void
}
const CANCELLED: InspectionResult = { ok: false, message: 'Check cancelled.' }

/**
 * `pi mcp list --json`: every enabled server, connected once. pi exits 1 when any
 * of them is not connected; the report on stdout still stands. stderr is never
 * read, since native config commands may put secrets in an error.
 */
export function runMcpList(
  cli: McpInspectorCli,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<PrintModeResult> {
  return runPrintMode(cli.binaryPath, [...(cli.prefixArgs ?? []), 'mcp', 'list', '--json'], {
    cwd: cli.cwd,
    env: cli.env,
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    stderr: 'ignore',
    reportExitCodes: [1],
  })
}

/**
 * Single-server native probes. Reports settle before native OAuth cleanup completes.
 * Cancellation stops UI work but lets pi finish credential-safe cleanup. Concurrency
 * counts draining children, not only unresolved callers. Shutdown has a hard bound.
 */
export class McpInspector {
  private queue: Job[] = []
  private running = new Set<Job>()
  private disposed = false
  constructor(private readonly options = { displayTimeoutMs: 30_000, cleanupTimeoutMs: 120_000 }) {}

  check(cli: McpInspectorCli, name: string, signal: AbortSignal): Promise<InspectionResult> {
    if (this.disposed || signal.aborted) return Promise.resolve(CANCELLED)
    if (!MCP_SERVER_NAME.test(name))
      return Promise.resolve({ ok: false, message: 'Invalid connector name.' })
    if (this.queue.length >= 128)
      return Promise.resolve({ ok: false, message: 'Too many queued checks.' })
    return new Promise((resolve) => {
      const job: Job = {
        cli,
        name,
        signal,
        resolve,
        settled: false,
        abort: () => {
          this.queue = this.queue.filter((queued) => queued !== job)
          this.settle(job, CANCELLED)
        },
      }
      signal.addEventListener('abort', job.abort, { once: true })
      this.queue.push(job)
      this.pump()
    })
  }

  private settle(job: Job, result: InspectionResult): void {
    if (job.settled) return
    job.settled = true
    job.signal.removeEventListener('abort', job.abort)
    job.resolve(result)
  }

  private pump(): void {
    while (!this.disposed && this.running.size < 3 && this.queue.length) {
      const job = this.queue.shift()!
      if (job.signal.aborted) this.settle(job, CANCELLED)
      else this.start(job)
    }
  }

  private start(job: Job): void {
    this.running.add(job)
    let child: ChildProcess
    try {
      child = spawn(
        job.cli.binaryPath,
        [...(job.cli.prefixArgs ?? []), 'mcp', 'inspect', job.name, '--json', '--timeout', '15'],
        {
          cwd: job.cli.cwd,
          env: job.cli.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: OWN_GROUP,
        },
      )
    } catch {
      this.settle(job, { ok: false, message: 'Could not start pi.' })
      this.running.delete(job)
      this.pump()
      return
    }
    job.child = child
    job.closed = new Promise((resolve) => {
      job.didClose = resolve
    })
    this.observe(job, child)
  }

  private observe(job: Job, child: ChildProcess): void {
    let stdout = ''
    let unsupported = false
    let stderr = ''
    const displayTimer = setTimeout(
      () =>
        this.settle(job, {
          ok: false,
          message:
            'Check timed out. Native pi may still be finishing credential cleanup; retry shortly.',
        }),
      this.options.displayTimeoutMs,
    )
    const cleanupTimer = setTimeout(() => {
      this.settle(job, { ok: false, message: 'Native pi did not finish cleanup in time.' })
      killProcessTree(child)
    }, this.options.cleanupTimeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (job.settled) return
      stdout += chunk
      if (stdout.length > 2 * 1024 * 1024) {
        this.settle(job, { ok: false, message: 'Connector metadata exceeded the display limit.' })
        return
      }
      try {
        const report = parseMcpInspection(JSON.parse(stdout), job.name)
        if (report) this.settle(job, { ok: true, report })
      } catch {
        /* Wait for a complete JSON document. */
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      // Never expose stderr: native config commands may put secrets in an error.
      stderr = (stderr + chunk).slice(-4096)
      unsupported ||= /unknown (?:mcp )?command.*inspect|usage:.*mcp/i.test(stderr)
    })
    child.on('error', () => this.settle(job, { ok: false, message: 'Could not start pi.' }))
    child.on('close', () => {
      clearTimeout(displayTimer)
      clearTimeout(cleanupTimer)
      this.settle(
        job,
        unsupported
          ? {
              ok: false,
              unsupported: true,
              message:
                'This pi version does not support connector inspection. Upgrade pi to a release with mcp inspect.',
            }
          : { ok: false, message: 'Pi returned no valid connector inspection report.' },
      )
      this.running.delete(job)
      job.didClose?.()
      // Descendants holding stdio are covered by the cleanup deadline; after close,
      // kill any leftover group members as the common subprocess runner does.
      killProcessTree(child)
      this.pump()
    })
  }

  async dispose(force = false): Promise<void> {
    this.disposed = true
    for (const job of this.queue.splice(0)) this.settle(job, CANCELLED)
    const running = [...this.running]
    for (const job of running) {
      this.settle(job, CANCELLED)
      // Ordinary quit drains native refreshes. Signals/crashes cannot await cleanup.
      if (force && job.child) killProcessTree(job.child)
    }
    await Promise.all(running.map((job) => job.closed))
  }
}
