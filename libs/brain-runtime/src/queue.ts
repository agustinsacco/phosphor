import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'

export interface QueueOptions {
  store: BrainStore
  busy(path: string): boolean
  ready(): boolean
  run(job: BrainJob, signal: AbortSignal): Promise<void>
  changed(): void
  /** Only queued/waiting jobs; the runner records active cancellation itself. */
  cancelled?(job: BrainJob): void
  now(): number
}

interface QueueTask {
  older: Set<string>
  abort: AbortController
  run(signal: AbortSignal): Promise<void>
  resolve(): void
  reject(error: unknown): void
}

/** A single fork at a time. Waiting lanes never block an older runnable job. */
export class ExtractionQueue {
  private active: { id: string; abort: AbortController; done: Promise<void> } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private tasks: QueueTask[] = []
  private disposed = false
  private paused = false

  get accepting(): boolean {
    return !this.disposed && !this.paused
  }

  retry(id: string): void {
    if (!this.accepting) throw new Error('Brain is resetting.')
    this.options.store.retry(id)
    this.options.changed()
    this.kick()
  }

  recompute(id: string): void {
    this.options.store.updateJob(id, {
      state: 'refreshing',
      runStartedAt: null,
      error: null,
      progress: null,
    })
    this.options.changed()
    this.kick()
  }

  async pause(): Promise<void> {
    this.paused = true
    clearTimeout(this.timer)
    this.cancelTasks()
    this.active?.abort.abort()
    await this.active?.done
  }

  resume(): void {
    this.paused = false
    this.kick()
  }

  constructor(private readonly options: QueueOptions) {}

  kick(): void {
    if (!this.accepting) return
    clearTimeout(this.timer)
    const { store, changed } = this.options
    this.refreshStaleReviews()
    const waiting = this.updateWaiting()
    if (waiting) this.timer = setTimeout(() => this.kick(), 2000)
    if (this.active || !this.options.ready()) return
    const jobs = store.snapshot().jobs
    const refresh = jobs
      .filter((j) => j.state === 'refreshing')
      .sort((a, b) => (a.startedAt ?? a.queuedAt) - (b.startedAt ?? b.queuedAt))[0]
    const job = refresh ?? jobs.find((j) => j.state === 'queued')
    const task = this.tasks[0]
    if (!refresh && task && (!job || !task.older.has(job.id))) {
      this.tasks.shift()
      const done = Promise.resolve()
        .then(() => task.run(task.abort.signal))
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active = undefined
          this.options.changed()
          this.kick()
        })
      this.active = { id: 'tidy', abort: task.abort, done }
      return
    }
    if (!job) return
    const abort = new AbortController()
    const running = store.updateJob(job.id, {
      state: refresh ? 'refreshing' : 'running',
      startedAt: job.startedAt ?? this.options.now(),
      runStartedAt: this.options.now(),
      error: null,
    })
    changed()
    // Start on a microtask so cancellation always sees the active run first.
    const done = Promise.resolve().then(() => this.execute(running, abort))
    this.active = { id: job.id, abort, done }
  }

  private refreshStaleReviews(): void {
    const { store, changed } = this.options
    for (const job of store.snapshot().jobs) {
      if (job.state !== 'review') continue
      const proposal = store.storedProposal(job.id)
      if (!proposal || proposal.computedRevision === store.knowledgeRevision()) continue
      store.updateJob(job.id, {
        state: 'refreshing',
        runStartedAt: null,
        error: null,
        progress: null,
      })
      changed()
    }
  }

  private updateWaiting(): boolean {
    const { store, busy, changed } = this.options
    let waiting = false
    for (const job of store.snapshot().jobs) {
      if (job.state !== 'waiting' && job.state !== 'queued') continue
      const isBusy = busy(job.sessionPath)
      waiting ||= isBusy
      const state = isBusy ? 'waiting' : 'queued'
      if (job.state !== state) {
        store.updateJob(job.id, { state })
        changed()
      }
    }
    return waiting
  }

  /** A lane-less task shares the worker and waits behind already runnable lane reads. */
  enqueueTask(run: QueueTask['run']): { done: Promise<void>; cancel(): void } {
    if (!this.accepting) throw new Error('Brain is resetting.')
    const abort = new AbortController()
    let task: QueueTask
    const done = new Promise<void>((resolve, reject) => {
      task = {
        older: new Set(this.options.store.snapshot().jobs.map((job) => job.id)),
        abort,
        run,
        resolve,
        reject,
      }
      this.tasks.push(task)
    })
    const cancel = (): void => {
      abort.abort()
      const index = this.tasks.indexOf(task)
      if (index >= 0) {
        this.tasks.splice(index, 1)
        task.reject(new Error('Brain Tidy cancelled.'))
      }
    }
    this.kick()
    return { done, cancel }
  }

  private cancelTasks(): void {
    for (const task of this.tasks.splice(0)) {
      task.abort.abort()
      task.reject(new Error('Brain Tidy cancelled.'))
    }
  }

  cancel(id: string): void {
    const job = this.options.store.job(id)
    if (job?.state === 'review' || job?.state === 'refreshing' || job?.state === 'done')
      throw new Error('Review this proposal to dismiss it.')
    if (this.active?.id === id) this.active.abort.abort()
    if (job?.state === 'empty' && !job.replaces) this.options.store.updateJob(id, { state: 'done' })
    else this.options.store.removeJob(id)
    if (job && this.active?.id !== id && (job.state === 'queued' || job.state === 'waiting'))
      this.options.cancelled?.(job)
    this.options.changed()
    this.kick()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.timer)
    this.cancelTasks()
    this.active?.abort.abort()
    await this.active?.done
  }

  private async execute(job: BrainJob, abort: AbortController): Promise<void> {
    try {
      // The runner observes pre-start cancellation too, so it can record the failure phase.
      await this.options.run(job, abort.signal)
    } catch (error) {
      if (!abort.signal.aborted && this.options.store.job(job.id)) {
        this.options.store.updateJob(job.id, {
          state: 'failed',
          finishedAt: this.options.now(),
          error:
            error instanceof Error ? error.message.slice(0, 300) : 'Knowledge extraction failed.',
        })
      }
    } finally {
      this.active = undefined
      this.options.changed()
      this.kick()
    }
  }
}
