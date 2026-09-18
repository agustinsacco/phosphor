import type { RoutineInput, RoutineRun, RoutineRunStatus, RoutinesSnapshot } from '@shared/routines'
import type { RoutineRepository } from './repository'
import type { RunOutcome } from './outcome'

export type RoutineExecutor = (
  run: RoutineRun,
  signal: AbortSignal,
  progress: (patch: Partial<RoutineRun>) => void,
) => Promise<RunOutcome>
interface Execution {
  controller: AbortController
  task: Promise<void>
  stop?: { status: RoutineRunStatus; reason: string }
}

/** Admission for explicitly configured routines only; never manages interactive lanes. */
export class RoutineScheduler {
  private timer?: ReturnType<typeof setInterval>
  private readonly executions = new Map<string, Execution>()
  private stopping = false
  private error: string | null = null

  constructor(
    readonly repository: RoutineRepository,
    private readonly execute: RoutineExecutor,
    private readonly changed: () => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly notify: (run: RoutineRun) => void = () => {},
  ) {}

  snapshot(): RoutinesSnapshot {
    const recent = this.repository.history(undefined, 0, 200)
    const runs = [...this.repository.pending(), ...recent]
    return {
      routines: this.repository.routines(),
      runs: [...new Map(runs.map((r) => [r.id, r])).values()],
      background: this.repository.background(),
      error: this.error,
    }
  }

  start(): void {
    this.repository.recover(this.now())
    this.tick()
    this.timer = setInterval(() => this.tick(), 15000)
    this.timer.unref()
  }

  save(input: RoutineInput, id?: string, revision?: number): void {
    this.repository.save(input, this.now(), id, revision)
    this.changed()
    this.tick()
  }

  runNow(id: string, requestId: string): RoutineRun {
    if (this.stopping || this.error) throw new Error(this.error ?? 'Phosphor is shutting down.')
    const run = this.repository.manual(id, requestId, this.now())
    this.tick()
    return this.repository.run(run.id)
  }

  tick(): void {
    if (this.stopping || this.error) return
    try {
      this.repository.reconcile(this.now())
      for (const queued of this.repository.pending().filter((r) => r.status === 'queued')) {
        if (
          this.now() - queued.scheduledAt >
          Math.max(60000, queued.definition.catchUpHours * 3600000)
        ) {
          this.repository.finish(queued.id, 'skipped', 'Queue deadline exceeded.', this.now())
          continue
        }
        if (this.executions.size >= 2) break
        // Serialize routines sharing a source folder, even when isolated. This
        // also avoids worktree-name/git-index races during preparation.
        const busy = this.repository
          .pending()
          .some(
            (r) =>
              r.status === 'running' &&
              (r.routineId === queued.routineId ||
                r.definition.workspacePath === queued.definition.workspacePath),
          )
        if (busy) continue
        const run = this.repository.claim(queued.id, this.now())
        if (run) this.launch(run)
      }
      this.changed()
    } catch (error) {
      this.failClosed(error)
    }
  }

  private launch(run: RoutineRun): void {
    const execution: Execution = { controller: new AbortController(), task: Promise.resolve() }
    this.executions.set(run.id, execution)
    const timeout = setTimeout(() => {
      execution.stop = {
        status: 'timed-out',
        reason:
          'Runtime limit reached. External actions may already have completed; inspect the lane before retrying.',
      }
      execution.controller.abort()
    }, run.definition.maxRuntimeMinutes * 60000)
    execution.task = (async () => {
      try {
        const outcome = await this.execute(run, execution.controller.signal, (patch) => {
          this.repository.patchRun(run.id, patch)
          Object.assign(run, patch)
          this.changed()
        })
        if (outcome.summary) this.repository.patchRun(run.id, { summary: outcome.summary })
        const result = execution.stop ?? outcome
        this.repository.finish(run.id, result.status, result.reason.slice(0, 8000), this.now())
        this.notify(this.repository.run(run.id))
      } catch (error) {
        try {
          this.repository.finish(
            run.id,
            'interrupted',
            `Execution stopped unexpectedly: ${String(error)}`,
            this.now(),
          )
        } catch (storageError) {
          this.failClosed(storageError)
        }
      } finally {
        clearTimeout(timeout)
        this.executions.delete(run.id)
        this.changed()
        this.tick()
      }
    })()
  }

  cancel(id: string): void {
    const execution = this.executions.get(id)
    if (execution) {
      execution.stop = {
        status: 'cancelled',
        reason: 'Cancelled by you. External actions may already have completed.',
      }
      execution.controller.abort()
    } else this.repository.finish(id, 'cancelled', 'Cancelled before execution.', this.now())
    this.changed()
  }

  async cancelAndWait(id: string): Promise<void> {
    const task = this.executions.get(id)?.task
    this.cancel(id)
    await task
  }

  pauseAll(): void {
    for (const routine of this.repository.routines().filter((r) => r.enabled && !r.archived)) {
      this.repository.save({ ...routine, enabled: false }, this.now(), routine.id, routine.revision)
    }
    this.changed()
  }

  async stop(): Promise<void> {
    this.stopping = true
    clearInterval(this.timer)
    for (const execution of this.executions.values()) {
      execution.stop = {
        status: 'interrupted',
        reason:
          'Phosphor quit or restarted during this run. Inspect any partial output before resuming; nothing was replayed.',
      }
      execution.controller.abort()
    }
    await Promise.allSettled([...this.executions.values()].map((e) => e.task))
  }

  private failClosed(error: unknown): void {
    this.error = `Routine scheduling stopped: ${String(error)}. Restart Phosphor after resolving the problem.`
    for (const execution of this.executions.values()) {
      execution.stop = { status: 'interrupted', reason: this.error }
      execution.controller.abort()
    }
    this.changed()
  }
}
