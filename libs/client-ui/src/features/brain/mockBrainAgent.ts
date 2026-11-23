import { brainLaneNeverRead } from '@shared/brain'
import type { BrainStatus, BrainJob } from '@shared/brain'
import type { BrainWaitingCounts } from '@shared/brain-agent'
import type { MockTidy } from './tidy/mockTidy'

export const MOCK_BRAIN_FOLDER = '/demo/brain/Brain'
export const MOCK_BRAIN_SESSION = `${MOCK_BRAIN_FOLDER}/brain-agent.jsonl`

/** Clock-driven ordinary Brain lane, with no provider or external side effects. */
export class MockBrainAgent {
  private next = 0
  private readsAhead = new Set<string>()
  private steps: (() => void)[] = []
  constructor(
    private state: BrainStatus,
    private tidy: MockTidy,
    private now: () => number,
    private decide: (job: BrainJob) => () => void,
  ) {
    state.agent.folder = MOCK_BRAIN_FOLDER
  }

  waiting(): BrainWaitingCounts {
    const counts = this.tidy.agent.waitingCounts()
    return {
      reads: this.state.jobs.filter((j) => ['review', 'refreshing'].includes(j.state)).length,
      ...counts,
    }
  }
  canRead(id: string): boolean {
    return this.state.agent.run?.state !== 'queued' || this.readsAhead.has(id)
  }
  active(): boolean {
    return this.state.agent.run?.state === 'running'
  }
  tick(): void {
    const run = this.state.agent.run
    if (!run || !['queued', 'running'].includes(run.state)) return
    if (run.state === 'queued') {
      if (
        this.now() <= run.queuedAt ||
        this.state.jobs.some(
          (j) => this.readsAhead.has(j.id) && ['queued', 'waiting', 'running'].includes(j.state),
        )
      )
        return
      const jobs = this.state.jobs.filter((j) => ['review', 'refreshing'].includes(j.state))
      const suggestions = this.tidy.agent.waitingIds()
      this.steps = [
        ...jobs.map((job) => () => {
          const before = structuredClone(job)
          let undoRead: (() => void) | undefined
          const never = brainLaneNeverRead(this.state.prefs.neverRead, job)
          this.tidy.agent.change(
            run.id,
            never ? 'reject' : 'approve',
            `${never ? 'Rejected' : 'Approved'} ${job.title}`,
            never
              ? 'Brain never reads this lane.'
              : 'The lasting memories have evidence in this read.',
            () => {
              undoRead = this.decide(job)
            },
            job.id,
            () => {
              undoRead?.()
              if (!this.state.jobs.some((read) => read.id === before.id))
                this.state.jobs.push(before)
            },
          )
        }),
        ...suggestions.map(
          (id, index) => () =>
            this.tidy.agent.resolve(run.id, id, index === suggestions.length - 1),
        ),
      ]
      run.state = 'running'
      run.startedAt = this.now()
      run.total = this.steps.length
      run.sessionPath = MOCK_BRAIN_SESSION
      this.next = this.now() + 750
    }
    while (this.steps.length && this.now() >= this.next) {
      this.steps.shift()!()
      run.decided++
      this.next += 750
    }
    const operations = this.tidy.agent.runChanges(run.id)
    run.erased = operations.filter((op) => op.kind === 'erase').length
    run.undoable = operations.filter((op) => op.undoable).length
    if (!this.steps.length) {
      run.state = 'done'
      run.finishedAt = this.now()
    }
  }
  call(channel: string, args: unknown[]): BrainStatus {
    if (channel === 'brain:undoRun') {
      if (
        args.length !== 1 ||
        typeof args[0] !== 'string' ||
        !args[0].length ||
        args[0].length > 200
      )
        throw new Error('Invalid Brain request.')
      const run = this.state.agent.run
      if (!run || run.id !== args[0] || ['queued', 'running'].includes(run.state))
        throw new Error('This Defrag run cannot be undone now.')
      const result = this.tidy.agent.undoRun(run.id)
      run.undoable = 0
      return Object.assign(this.state, result)
    }
    if (args.length) throw new Error('Invalid Brain request.')
    if (channel === 'brain:defragStop') {
      const run = this.state.agent.run
      if (run && ['queued', 'running'].includes(run.state)) {
        run.state = 'stopped'
        run.finishedAt = this.now()
        this.steps = []
      }
      return this.state
    }
    if (!this.state.prefs.enabled) throw new Error('Turn Brain on first.')
    if (this.state.agent.run && ['queued', 'running'].includes(this.state.agent.run.state))
      throw new Error('Defrag is already queued or running.')
    if (!Object.values(this.waiting()).some(Boolean))
      throw new Error('Nothing is waiting for Defrag.')
    this.readsAhead = new Set(this.state.jobs.map((job) => job.id))
    this.state.agent.run = {
      id: crypto.randomUUID(),
      state: 'queued',
      total: 0,
      decided: 0,
      erased: 0,
      undoable: 0,
      queuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      sessionPath: null,
      error: null,
      rulesChanged: false,
    }
    return this.state
  }
}
