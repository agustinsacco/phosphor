import type { BrainStatus } from '@shared/brain'
import type { BrainAgentRun, BrainWaitingCounts } from '@shared/brain-agent'
import type { MockTidy } from './tidy/mockTidy'

export const MOCK_BRAIN_FOLDER = '/demo/brain/Brain'
export const MOCK_BRAIN_SESSION = `${MOCK_BRAIN_FOLDER}/brain-agent.jsonl`
/** Desktop waits 60 quiet seconds after a saved read; the mock's clock may be shorter. */
export const MOCK_AUTO_RUN_MS = 60_000

/**
 * Clock-driven ordinary Brain lane, with no provider or external side effects. Defrag starts a
 * run; once reads settle after a saved read, a run also starts on its own while anything waits.
 */
export class MockBrainAgent {
  private next = 0
  private readsAhead = new Set<string>()
  private steps: (() => void)[] = []
  /** When the last read saved, until an automatic run takes it. */
  private savedAt: number | null = null
  constructor(
    private state: BrainStatus,
    private tidy: MockTidy,
    private now: () => number,
    private autoRunMs = MOCK_AUTO_RUN_MS,
  ) {
    state.agent.folder = MOCK_BRAIN_FOLDER
  }

  waiting(): BrainWaitingCounts {
    return this.tidy.agent.waitingCounts()
  }
  readSaved(): void {
    this.savedAt = this.now()
  }
  canRead(id: string): boolean {
    return this.state.agent.run?.state !== 'queued' || this.readsAhead.has(id)
  }
  active(): boolean {
    return this.state.agent.run?.state === 'running'
  }
  private busy(): boolean {
    return !!this.state.agent.run && ['queued', 'running'].includes(this.state.agent.run.state)
  }
  /** Edge-triggered: one attempt per saved read, after reads settle, while something waits. */
  private autoStart(): void {
    if (this.savedAt === null || !this.state.prefs.agentAuto || this.busy()) return
    if (this.state.jobs.some((j) => ['queued', 'running'].includes(j.state))) return
    if (this.now() - this.savedAt < this.autoRunMs) return
    this.savedAt = null
    if (Object.values(this.waiting()).some(Boolean)) this.queueRun(true)
  }
  tick(): void {
    this.autoStart()
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
      const suggestions = this.tidy.agent.waitingIds()
      this.steps = suggestions.map(
        (id, index) => () => this.tidy.agent.resolve(run.id, id, index === suggestions.length - 1),
      )
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
  private queueRun(automatic: boolean): void {
    // Any run takes the saved reads before it: the automatic one waits for the next.
    this.savedAt = null
    this.readsAhead = new Set(this.state.jobs.map((job) => job.id))
    const run: BrainAgentRun = {
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
      automatic,
    }
    this.state.agent.run = run
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
    if (this.busy()) throw new Error('Defrag is already queued or running.')
    if (!Object.values(this.waiting()).some(Boolean))
      throw new Error('Nothing is waiting for Defrag.')
    this.queueRun(false)
    return this.state
  }
}
