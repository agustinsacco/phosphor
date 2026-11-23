import { brainLaneNeverRead, type BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { LaneReadCheck } from './lane-read-rules'
import { returnToReview } from './stale-review'
import { DeletedLaneError, type LaneEntry } from './transcript'

export interface QueueOptions {
  store: BrainStore
  busy(path: string): boolean
  ready(): boolean
  /** entries: the transcript the start check read, when it had to read one. */
  run(job: BrainJob, signal: AbortSignal, entries?: LaneEntry[]): Promise<void>
  changed(): void
  /** Only queued/waiting jobs; the runner records active cancellation itself. */
  cancelled?(job: BrainJob, reason?: string): void
  /** Whether a job's lane may be read now: at every start, and ahead of time for reviews. */
  check?(job: BrainJob): Promise<LaneReadCheck>
  now(): number
}

interface QueueTask {
  older: Set<string>
  abort: AbortController
  run(signal: AbortSignal): Promise<void>
  resolve(): void
  reject(error: unknown): void
}

/** The worker's id while a lane-less task (Defrag) holds it. */
const DEFRAG_TASK = 'defrag'
const CANCELLED = 'Brain task cancelled.'

const titleRules = (store: BrainStore): string =>
  JSON.stringify(store.snapshot().prefs.neverRead.titles)

/**
 * A single fork at a time. Waiting lanes never block an older runnable job. A stale review waits
 * in review: only `recompute` (Brain Agent opening it outside a run) and `refreshInline` (inside
 * Defrag) refresh it, never a pass of the queue.
 */
export class ExtractionQueue {
  private active: { id: string; abort: AbortController; done: Promise<void> } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private tasks: QueueTask[] = []
  private checking: Promise<void> | undefined
  private blocked = new Set<string>()
  /** The title rules every waiting and queued job was last checked against. */
  private checkedRules: string
  private disposed = false
  private paused = false
  /** Inline refreshes, one at a time, and how many are queued or running. */
  private inline: Promise<void> = Promise.resolve()
  private inlineBusy = 0

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

  abortRefresh(id: string): void {
    if (this.options.store.job(id)?.state === 'refreshing' && this.active?.id === id)
      this.active.abort.abort()
  }

  async pause(): Promise<void> {
    this.paused = true
    clearTimeout(this.timer)
    this.cancelTasks()
    this.active?.abort.abort()
    await this.active?.done
    await this.checking
  }

  resume(): void {
    this.paused = false
    this.kick()
  }

  constructor(private readonly options: QueueOptions) {
    this.checkedRules = titleRules(options.store)
  }

  kick(): void {
    if (!this.accepting) return
    this.updateWaiting()
    if (this.checking || this.active) return
    const rules = titleRules(this.options.store)
    if (
      !this.options.check ||
      !this.options.store.snapshot().jobs.some((job) => this.needsCheck(job, rules))
    ) {
      this.checkedRules = rules
      this.start()
      return
    }
    this.checking = this.checkPending(rules).finally(() => {
      this.checking = undefined
      if (this.accepting) this.start()
    })
  }

  /**
   * Reviews are checked ahead of time, so a blocked one is never marked refreshing. Waiting and
   * queued reads are checked when they start, and that read is handed to the run; ahead of time
   * only after the title rules change. Ids are excluded synchronously by updateWaiting.
   */
  private needsCheck(job: BrainJob, rules: string): boolean {
    if (job.state === 'waiting' || job.state === 'queued') return rules !== this.checkedRules
    if (job.state === 'refreshing') return true
    const proposal = this.options.store.storedProposal(job.id)
    return (
      job.state === 'review' &&
      proposal !== undefined &&
      proposal.computedRevision !== this.options.store.knowledgeRevision()
    )
  }

  /** Lane files are read only when they changed; a pass that changes nothing notifies nobody. */
  private async checkPending(rules: string): Promise<void> {
    const { store, check, changed } = this.options
    const blocked = new Set<string>()
    for (const job of store.snapshot().jobs) {
      if (!this.needsCheck(job, rules)) continue
      try {
        const { refusal, retitled } = await check!(job)
        if (!this.accepting) return
        if (!['waiting', 'queued', 'review', 'refreshing'].includes(store.job(job.id)?.state ?? ''))
          continue
        if (refusal) blocked.add(job.id)
        if ((refusal && this.exclude(job, refusal)) || retitled) changed()
      } catch (error) {
        if (this.accepting && store.storedProposal(job.id)) {
          store.updateJob(job.id, {
            state: 'failed',
            finishedAt: this.options.now(),
            error:
              error instanceof Error
                ? error.message.slice(0, 300)
                : 'Could not refresh this review.',
          })
          changed()
        }
        // The runner reports unreadable new lanes when they start, not while waiting.
      }
    }
    this.blocked = blocked
    this.checkedRules = rules
  }

  private start(): void {
    if (!this.accepting) return
    clearTimeout(this.timer)
    const { store, changed } = this.options
    const waiting = this.updateWaiting()
    if (waiting) this.timer = setTimeout(() => this.kick(), 2000)
    if (this.active || !this.options.ready()) return
    const jobs = store.snapshot().jobs
    const refresh = jobs
      .filter((j) => j.state === 'refreshing' && !this.blocked.has(j.id))
      .sort((a, b) => (a.startedAt ?? a.queuedAt) - (b.startedAt ?? b.queuedAt))[0]
    const job = refresh ?? jobs.find((j) => j.state === 'queued')
    const task = this.tasks[0]
    if (!refresh && task && (!job || !task.older.has(job.id))) {
      this.tasks.shift()
      const done = Promise.resolve()
        .then(() => task.run(task.abort.signal))
        .then(task.resolve, task.reject)
        .then(() => this.releaseTask())
      this.active = { id: DEFRAG_TASK, abort: task.abort, done }
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

  private updateWaiting(): boolean {
    const { store, busy, changed } = this.options
    let waiting = false
    const { prefs, jobs } = store.snapshot()
    for (const job of jobs) {
      if (job.state !== 'waiting' && job.state !== 'queued') continue
      if (
        brainLaneNeverRead(
          { ...prefs.neverRead, titles: this.options.check ? [] : prefs.neverRead.titles },
          job,
        )
      ) {
        this.exclude(job)
        changed()
        continue
      }
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
        task.reject(new Error(CANCELLED))
      }
    }
    this.kick()
    return { done, cancel }
  }

  private cancelTasks(): void {
    for (const task of this.tasks.splice(0)) {
      task.abort.abort()
      task.reject(new Error(CANCELLED))
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
    await this.checking
  }

  /** Returns whether the store changed: a review already in review stays as it is. */
  private exclude(job: BrainJob, reason?: string): boolean {
    const { store } = this.options
    // Retry and pre-upgrade recomputes can be queued/running while still owning a review.
    if (store.storedProposal(job.id)) {
      this.blocked.add(job.id)
      if (store.job(job.id)?.state === 'review') return false
      store.updateJob(job.id, { state: 'review', runStartedAt: null })
    } else {
      store.removeJob(job.id)
      this.options.cancelled?.(job, reason)
    }
    return true
  }

  private async execute(job: BrainJob, abort: AbortController): Promise<void> {
    try {
      await this.runJob(job, abort.signal)
    } finally {
      this.active = undefined
      this.options.changed()
      this.kick()
    }
  }

  /** The start check, then the read; a failure is recorded on the job unless it was aborted. */
  private async runJob(job: BrainJob, signal: AbortSignal): Promise<void> {
    try {
      const check = this.options.check ? await this.options.check(job) : null
      // The check may have stored the lane's current title; the read records that one.
      const current = this.options.store.job(job.id)
      if (signal.aborted || !current) return
      if (check?.refusal) {
        this.exclude(job, check.refusal)
        return
      }
      // The runner observes pre-start cancellation too, so it can record the failure phase.
      await this.options.run(current, signal, check?.entries)
    } catch (error) {
      if (!signal.aborted && this.options.store.job(job.id)) {
        // The lane can disappear after preflight, before the runner opens its archived twin.
        if (
          error instanceof DeletedLaneError &&
          error.path === job.sessionPath &&
          this.options.store.storedProposal(job.id)
        )
          this.exclude(job)
        else
          this.options.store.updateJob(job.id, {
            state: 'failed',
            finishedAt: this.options.now(),
            error:
              error instanceof Error ? error.message.slice(0, 300) : 'Knowledge extraction failed.',
          })
      }
    }
  }

  /** Defrag holds the worker: reviews it makes stale wait for it, unless it refreshes them inline. */
  get defragActive(): boolean {
    return this.active?.id === DEFRAG_TASK
  }

  /**
   * Inside the active Defrag task only: refresh one stale review now, through the queue's own run
   * path and under the task's signal. Calls wait for each other, so two model runs never overlap.
   */
  refreshInline(id: string, signal: AbortSignal): Promise<void> {
    this.inlineBusy++
    const next = this.inline.then(() => this.refreshNow(id, signal))
    this.inline = next
      .catch(() => undefined)
      .then(() => {
        this.inlineBusy--
      })
    return next
  }

  /** Inline refreshes the task started keep the worker until they settle, even after Stop. */
  private releaseTask(): Promise<void> | undefined {
    if (this.inlineBusy) return this.inline.then(() => this.releaseTask())
    this.active = undefined
    this.options.changed()
    this.kick()
    return undefined
  }

  private async refreshNow(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.defragActive) throw new Error('Only Defrag refreshes a review inline.')
    const { store, changed, now } = this.options
    const job = store.job(id)
    const proposal = store.storedProposal(id)
    if (!job || !proposal || (job.state !== 'review' && job.state !== 'refreshing')) return
    if (job.state === 'review' && proposal.computedRevision === store.knowledgeRevision()) return
    const running = store.updateJob(id, {
      state: 'refreshing',
      runStartedAt: now(),
      error: null,
      progress: null,
    })
    changed()
    try {
      await this.runJob(running, signal)
    } finally {
      // Stopped mid-refresh: it waits, stale, for Brain Agent to open it again.
      if (store.job(id)?.state === 'refreshing') returnToReview(store, id)
      changed()
    }
    signal.throwIfAborted()
  }
}
