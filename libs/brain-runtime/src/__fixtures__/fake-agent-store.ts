import type { BrainAgentRun, BrainWaitingCounts } from '@phosphor/shared/brain-agent'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { FakeBrainStore } from './fake-store'

type Note = Parameters<BrainStore['erase']>[1]
export interface AgentCall {
  method: string
  args: unknown[]
  note: Note
}

/** FakeBrainStore with Defrag runs in memory and Brain Agent writes recorded, not applied. */
export class FakeAgentStore extends FakeBrainStore {
  runs: BrainAgentRun[] = []
  counts: BrainWaitingCounts = { reads: 0, entities: 0, repeats: 0, conflicts: 0, flags: 0 }
  calls: AgentCall[] = []
  /** Thrown by the next write, as an engine refusal would be. */
  refusal: Error | null = null
  undone = { undone: 0, kept: 0 }
  interrupted: string[] = []
  private runIds = 0
  private operations = 0

  override waitingCounts = () => ({ ...this.counts })
  override createRun = (): BrainAgentRun => {
    const run: BrainAgentRun = {
      id: `run-${++this.runIds}`,
      state: 'queued',
      total: 0,
      decided: 0,
      erased: 0,
      undoable: 0,
      queuedAt: 100,
      startedAt: null,
      finishedAt: null,
      error: null,
      sessionPath: null,
      rulesChanged: false,
    }
    this.runs.push(run)
    return { ...run }
  }
  override updateRun = (id: string, patch: Partial<BrainAgentRun>): BrainAgentRun => {
    const run = this.runs.find((r) => r.id === id)
    if (!run) throw new Error('Brain Agent run not found.')
    Object.assign(run, patch)
    return { ...run }
  }
  override latestRun = (): BrainAgentRun | null => {
    const run = this.runs.at(-1)
    return run ? { ...run } : null
  }
  override interruptRuns = (message: string): void => {
    this.interrupted.push(message)
    for (const run of this.runs)
      if (run.state === 'queued' || run.state === 'running')
        Object.assign(run, { state: 'failed', error: message, finishedAt: 1 })
  }
  override undoRun = (runId: string) => {
    this.calls.push({ method: 'undoRun', args: [runId], note: { runId, reason: '' } })
    this.rev++
    return { ...this.undone }
  }

  private write(method: string, args: unknown[], note: Note): string {
    if (this.refusal) {
      const error = this.refusal
      this.refusal = null
      throw error
    }
    this.calls.push({ method, args, note: { ...note } })
    this.rev++
    return `op-${++this.operations}`
  }
  override decideRead = (
    jobId: string,
    decision: Parameters<BrainStore['decideRead']>[1],
    revision: number,
    note: Note,
  ) => {
    const operationId = this.write('decideRead', [jobId, decision, revision], note)
    this.updateJob(jobId, { state: decision ? 'done' : 'rejected' })
    this.proposals.delete(jobId)
    return { operationId, touched: { entityIds: [], memoryIds: [] } }
  }
  override resolve = (id: string, action: unknown, note: Note) =>
    this.write('resolve', [id, action], note)
  override agentEdit = (edit: unknown, note: Note) => this.write('agentEdit', [edit], note)
  override correct = (input: unknown, vector: Float32Array | null, note: Note) =>
    this.write('correct', [input, vector], note)
  override erase = (memoryId: string, note: Note) => this.write('erase', [memoryId], note)
  override agentUndo = (operationId: string, note: Note): void => {
    this.write('agentUndo', [operationId], note)
  }
}
