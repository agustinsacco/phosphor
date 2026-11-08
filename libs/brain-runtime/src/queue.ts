import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'

export interface QueueOptions {
  store: BrainStore
  busy(path: string): boolean
  ready(): boolean
  run(job: BrainJob, signal: AbortSignal): Promise<void>
  changed(): void
  now(): number
}

/** A single fork at a time. Waiting lanes never block an older runnable job. */
export class ExtractionQueue {
  private active: { id: string; abort: AbortController; done: Promise<void> } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly options: QueueOptions) {}

  kick(): void {
    if (this.disposed) return
    clearTimeout(this.timer)
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
    if (waiting) this.timer = setTimeout(() => this.kick(), 2000)
    if (this.active || !this.options.ready()) return
    const job = store.snapshot().jobs.find((j) => j.state === 'queued')
    if (!job) return
    const abort = new AbortController()
    store.updateJob(job.id, { state: 'running', startedAt: this.options.now(), error: null })
    changed()
    // Start on a microtask so cancellation always sees the active run first.
    const done = Promise.resolve().then(() => this.execute(job, abort))
    this.active = { id: job.id, abort, done }
  }

  cancel(id: string): void {
    const job = this.options.store.job(id)
    if (job?.state === 'review' || job?.state === 'done')
      throw new Error('Review this proposal to dismiss it.')
    if (this.active?.id === id) this.active.abort.abort()
    if (job?.state === 'empty') this.options.store.updateJob(id, { state: 'done' })
    else this.options.store.removeJob(id)
    this.options.changed()
    this.kick()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.timer)
    this.active?.abort.abort()
    await this.active?.done
  }

  private async execute(job: BrainJob, abort: AbortController): Promise<void> {
    try {
      abort.signal.throwIfAborted()
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
