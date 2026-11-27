import { brainLaneNeverRead, type BrainJob } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { LaneReadCheck } from './lane-read-rules'
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
  /** Whether a job's lane may be read now: at every start. */
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

/** A single fork at a time. Waiting lanes never block a runnable job. */
export class ExtractionQueue {
  private active: { id: string; abort: AbortController; done: Promise<void> } | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private tasks: QueueTask[] = []
  private checking: Promise<void> | undefined
  /** The title rules every waiting and queued job was last checked against. */
  private checkedRules: string
  private disposed = false
  private paused = false
  get hasWork(): boolean {
    return !this.accepting || !!this.active || !!this.checking || this.tasks.length > 0
  }

  get accepting(): boolean {
    return !this.disposed && !this.paused
  }

  retry(id: string): void {
    if (!this.accepting) throw new Error('Brain is resetting.')
    this.options.store.retry(id)
    this.options.changed()
    this.kick()
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

  private needsCheck(job: BrainJob, rules: string): boolean {
    return (job.state === 'waiting' || job.state === 'queued') && rules !== this.checkedRules
  }

  /** Lane files are read only when they changed; a pass that changes nothing notifies nobody. */
  private async checkPending(rules: string): Promise<void> {
    const { store, check, changed } = this.options
    for (const job of store.snapshot().jobs) {
      if (!this.needsCheck(job, rules)) continue
      try {
        const { refusal, retitled } = await check!(job)
        if (!this.accepting) return
        if (!['waiting', 'queued'].includes(store.job(job.id)?.state ?? '')) continue
        if (refusal) this.exclude(job, refusal)
        if (refusal || retitled) changed()
      } catch {
        // The start check reports unreadable lanes, not this waiting pass.
      }
    }
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
    const job = jobs.find((j) => j.state === 'queued')
    const task = this.tasks[0]
    if (task && (!job || !task.older.has(job.id))) {
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
      state: 'running',
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
    if (job?.state === 'done') throw new Error('This read has already been saved.')
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

  private exclude(job: BrainJob, reason?: string): void {
    this.options.store.removeJob(job.id)
    this.options.cancelled?.(job, reason)
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
        const message =
          error instanceof DeletedLaneError &&
          error.path === job.sessionPath &&
          this.options.store.storedProposal(job.id)
            ? "This lane was deleted, so Brain can't finish reading it."
            : error instanceof Error
              ? error.message.slice(0, 300)
              : 'Knowledge extraction failed.'
        this.options.store.updateJob(job.id, {
          state: 'failed',
          finishedAt: this.options.now(),
          error: message,
        })
      }
    }
  }

  private releaseTask(): void {
    this.active = undefined
    this.options.changed()
    this.kick()
  }
}
