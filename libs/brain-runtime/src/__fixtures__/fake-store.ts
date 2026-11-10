import {
  DEFAULT_BRAIN_PREFS,
  type BrainExtractionRecord,
  type BrainJob,
  type BrainMemoryDetail,
  type BrainPrefs,
  type BrainProposalView,
  type BrainRecall,
  type BrainSnapshot,
} from '@phosphor/shared/brain'
import type {
  BrainStore,
  ProposalResult,
  Extraction,
  JobPatch,
  NewJob,
  SearchInput,
} from '@phosphor/memory-engine/types'

/** In-memory runtime double; the SQLite store's graph and dedup rules are tested by its owner. */
export class FakeBrainStore implements BrainStore {
  prefs: BrainPrefs = { ...DEFAULT_BRAIN_PREFS }
  revision = 0
  jobs: BrainJob[] = []
  records = new Map<string, BrainExtractionRecord>()
  saveExtraction(record: BrainExtractionRecord): void {
    this.records.set(record.jobId, record)
  }
  extraction(id: string) {
    const record = this.records.get(id)
    if (!record) throw new Error('Brain extraction not found.')
    return { ...record, memories: [] }
  }
  proposals = new Map<string, Extraction>()
  details: BrainMemoryDetail[] = []
  deliveries: { sessionId: string; memoryIds: string[] }[] = []
  searches: SearchInput[] = []
  recall: BrainRecall = {
    status: 'no_match',
    hits: [],
    entities: [],
    focus: [],
    links: [],
    more: 0,
    degradation: [],
  }
  closed = false
  private next = 0

  snapshot(): BrainSnapshot {
    return {
      prefs: { ...this.prefs },
      revision: this.revision,
      counts: { memories: this.details.length, entities: this.recall.entities.length },
      jobs: this.jobs.filter((j) => j.state !== 'done').map((j) => ({ ...j })),
    }
  }
  setPrefs(prefs: BrainPrefs): BrainPrefs {
    return (this.prefs = { ...prefs })
  }
  enqueue(input: NewJob, state: 'waiting' | 'queued'): BrainJob {
    if (
      this.jobs.some(
        (j) =>
          j.sessionId === input.sessionId &&
          ['waiting', 'queued', 'running', 'review'].includes(j.state),
      )
    )
      throw new Error('This lane is already queued.')
    const job: BrainJob = {
      ...input,
      id: `job-${++this.next}`,
      state,
      memories: 0,
      error: null,
      queuedAt: this.next,
      startedAt: null,
      finishedAt: null,
      usage: null,
    }
    this.jobs.push(job)
    return job
  }
  job(id: string): BrainJob | undefined {
    return this.jobs.find((j) => j.id === id)
  }
  updateJob(id: string, patch: JobPatch): BrainJob {
    const job = this.job(id)
    if (!job) throw new Error('No job')
    Object.assign(job, patch)
    return job
  }
  removeJob(id: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== id)
    this.proposals.delete(id)
  }
  requeueInterrupted(): void {
    for (const job of this.jobs) if (job.state === 'running') job.state = 'queued'
  }
  propose(extraction: Extraction): ProposalResult {
    this.proposals.set(extraction.jobId, extraction)
    this.updateJob(extraction.jobId, {
      state: extraction.memories.length ? 'review' : 'empty',
      memories: extraction.memories.length,
    })
    return {
      kept: extraction.memories.length,
      duplicates: 0,
      reconfirmed: 0,
      outcomes: extraction.memories.map((item, candidate) => ({
        candidate,
        summary: item.summary,
        status: 'kept',
        proposalIndex: candidate,
      })),
    }
  }
  proposal(jobId: string): BrainProposalView {
    const job = this.job(jobId)
    const proposal = this.proposals.get(jobId)
    if (!job || !proposal) throw new Error('No proposal')
    return {
      job,
      summary: proposal.summary,
      revision: this.revision,
      entities: proposal.entities.map((e) => ({ ...e, id: e.key })),
      memories: [],
      confirmations: [],
    }
  }
  review(jobId: string, keep: number[] | null, revision: number): void {
    if (revision !== this.revision)
      throw new Error('Brain changed while you were reviewing. Reopen the review.')
    this.updateJob(jobId, { state: 'done', memories: keep?.length ?? 0 })
    this.proposals.delete(jobId)
    this.revision++
  }
  knowledge() {
    return {
      memories: this.details.map((d) => d.memory),
      entities: this.recall.entities,
      truncated: false,
    }
  }
  memory(id: string): BrainMemoryDetail {
    const detail = this.details.find((d) => d.memory.id === id)
    if (!detail) throw new Error('No memory')
    return detail
  }
  forget(id: string): void {
    this.details = this.details.filter((d) => d.memory.id !== id)
    this.revision++
  }
  known() {
    return { memories: this.details.map((d) => d.memory), entities: this.recall.entities }
  }
  search(input: SearchInput): BrainRecall {
    this.searches.push(input)
    return this.recall
  }
  recordDelivery(sessionId: string, memoryIds: string[]): void {
    this.deliveries.push({ sessionId, memoryIds })
  }
  close(): void {
    this.closed = true
  }
}

export const HARBOR_JOB: NewJob = {
  sessionId: 'harbor-lane',
  sessionPath: '/made-up/harbor.jsonl',
  title: 'Harbor billing',
  scope: '/projects/harbor',
  branch: 'billing',
  model: 'example/fast',
  leafId: 'leaf',
}
