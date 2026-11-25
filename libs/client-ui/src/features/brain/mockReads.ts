import type { BrainJob, BrainMemoryDetail } from '@shared/brain'
import type { MockExplorer } from './mockExplorer'
import type { MockTidy } from './tidy/mockTidy'
import { brainLaneTitle } from './laneTitle'

/** What every mock read finds: two lasting notes, one of them a person-to-person link. */
function readNotes(job: BrainJob): { summary: string; entities: string[] }[] {
  return [
    { summary: 'Ledger invoices close on the fifth working day.', entities: ['ledger', 'harbor'] },
    {
      summary: `Tom Lee shared the ${brainLaneTitle(job.title)} notes with Mara Voss.`,
      entities: ['tom', 'mara'],
    },
  ]
}

/**
 * Finished reads, as Desktop keeps them: a read saves when it finishes, as one automatic
 * operation with Undo. Undo leaves the read rejected with nothing of its own, and Read again
 * starts from any finished read.
 */
export class MockReads {
  jobs: BrainJob[] = []
  constructor(
    private explorer: MockExplorer,
    private tidy: MockTidy,
    private now: () => number,
  ) {}
  memories(sessionId: string): BrainMemoryDetail[] {
    return this.explorer.details.filter((d) => d.memory.origin?.sessionId === sessionId)
  }
  /** Save a finished read: Read again replaces the lane's earlier memories first. */
  save(job: BrainJob): string {
    const notes = readNotes(job)
    const finished: BrainJob = {
      ...job,
      state: 'done',
      memories: notes.length,
      finishedAt: this.now(),
      runStartedAt: null,
      progress: null,
    }
    return this.tidy.recordRead(
      job.id,
      `Read ${brainLaneTitle(job.title)}: ${notes.length} memories`,
      () => {
        if (job.replaces)
          this.explorer.details = this.explorer.details.filter(
            (d) =>
              d.memory.origin?.sessionId !== job.sessionId ||
              d.memory.lanes > 1 ||
              d.memory.links.some((l) => l.statedBy !== 'reader'),
          )
        notes.forEach((note, index) => this.explorer.details.push(this.detail(job, note, index)))
        this.jobs.unshift(finished)
      },
      () => {
        const read = this.jobs.find((j) => j.id === job.id)
        if (read) Object.assign(read, { state: 'rejected', memories: 0 })
      },
    )
  }
  private detail(
    job: BrainJob,
    note: { summary: string; entities: string[] },
    index: number,
  ): BrainMemoryDetail {
    const template = structuredClone(this.explorer.details[0]!)
    const quotes = [{ before: '', quote: note.summary, after: '', label: `You · ${job.title}` }]
    return {
      ...template,
      memory: {
        ...template.memory,
        id: `${job.id}-memory-${index}`,
        jobId: job.id,
        summary: note.summary,
        entityIds: note.entities,
        links: [],
        type: 'fact',
        kind: 'reported',
        state: 'active',
        recordedAt: this.now(),
        observedAt: this.now(),
        origin: { sessionId: job.sessionId, title: job.title },
        importance: 1,
        saidBy: 'you',
        lanes: 1,
      },
      quotes,
      linkQuotes: {},
      history: [],
      related: [],
      sourcePath: job.sessionPath,
    }
  }
  /** `brain:laneRead`: the lane's newest finished read and what Read again would replace. */
  laneRead(sessionId: string): { job: BrainJob; memories: number; replaceable: number } | null {
    const job = this.jobs.find((j) => j.sessionId === sessionId)
    if (!job) return null
    const own = this.memories(sessionId).filter(({ memory }) => memory.state !== 'superseded')
    return {
      job,
      memories: own.length,
      replaceable: own.filter(
        (d) => d.memory.lanes <= 1 && d.memory.links.every((l) => l.statedBy === 'reader'),
      ).length,
    }
  }
}
