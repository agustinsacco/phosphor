import { MockTidy, type MockTidyOptions } from './tidy/mockTidy'
import { mockBrainPrefs } from './mockBrainPrefs'
import type { BrainEntitySort } from '@shared/brain-explore'
import type {
  BrainExtractionView,
  BrainEntityKind,
  BrainJob,
  BrainLaneRef,
  BrainMemoryFilter,
  BrainProposalView,
  BrainPredicate,
  BrainReviewDecision,
  BrainStatus,
} from '@shared/brain'
import { mockBrainJob, mockBrainProposal, mockBrainStatus } from './mockBrainData'
import { mockDemoJobs, mockStartingJobs, withDemoQuestions } from './mockBrainDemo'
import { applyMockReview, checkMockDecision } from './mockReview'
import { mockExtractionRecord } from './mockExtractionRecord'
import { MockExplorer } from './mockExplorer'
import { MockReadHistory } from './mockReadHistory'

export interface MockBrainOptions extends MockTidyOptions {
  /** The browser harness: a required question, held claims and a never-read review. */
  demoReviews?: boolean
}
/** A lane with one of these is already queued or waiting for the owner. */
const UNFINISHED: readonly BrainJob['state'][] = [
  'waiting',
  'queued',
  'running',
  'refreshing',
  'review',
]
const FINISHED: readonly BrainJob['state'][] = ['done', 'empty', 'rejected']

class MockBrain {
  private state = mockBrainStatus()
  private explorer = new MockExplorer()
  private history = new MockReadHistory(this.explorer)
  private records = new Map<string, BrainExtractionView>()
  private downloading: number | null = null
  private resets = 0
  private computedRevisions = new Map<string, number>()
  private tidy: MockTidy
  private demo: boolean
  constructor(
    private now: () => number,
    options: MockBrainOptions,
  ) {
    this.tidy = new MockTidy(this.explorer, this.state, now, options)
    this.demo = !!options.demoReviews
    this.state.jobs = [...mockStartingJobs(), ...(this.demo ? mockDemoJobs() : [])]
    // The demo review adds two held claims to the usual two memories.
    if (this.demo) this.state.jobs[0]!.memories = 4
    for (const job of this.state.jobs) {
      this.records.set(job.id, this.extractionRecord(job.id))
      this.computedRevisions.set(job.id, this.state.revision)
    }
  }
  private status(): BrainStatus {
    this.tidy.tick()
    this.state.tidy = this.tidy.summary()
    this.state.counts = {
      memories: this.explorer.details.length,
      entities: this.explorer.entities.length,
    }
    const read = [...this.history.jobs, ...this.state.jobs].filter((job) =>
      FINISHED.includes(job.state),
    )
    this.state.readSessionIds = [...new Set(read.map((job) => job.sessionId))].slice(0, 5000)
    return this.state
  }
  private review(id: string, decision: BrainReviewDecision | null, revision: number): BrainStatus {
    if (this.state.revision !== revision) throw new Error('Brain changed; refreshing this review')
    const proposal = this.proposal(id)
    checkMockDecision(proposal, decision)
    if (decision) {
      if (proposal.job.replaces)
        this.explorer.details = this.explorer.details.filter(
          (d) => d.memory.origin?.sessionId !== proposal.job.sessionId,
        )
      applyMockReview(this.explorer, proposal, decision)
      const record = this.records.get(id)
      if (record)
        for (const outcome of record.outcomes)
          outcome.memoryId = this.explorer.details.find(
            (d) => d.memory.jobId === id && d.memory.summary === outcome.summary,
          )?.memory.id
    }
    const job = this.state.jobs.find((item) => item.id === id)!
    if (decision) this.history.finish(proposal.job, this.now())
    // Rejecting Read again keeps the earlier read; rejecting a read keeps it as rejected.
    if (decision || proposal.job.replaces)
      this.state.jobs = this.state.jobs.filter((item) => item.id !== id)
    else Object.assign(job, { state: 'rejected', finishedAt: this.now(), progress: null })
    this.state.revision++
    return this.status()
  }
  private proposal(id: string): BrainProposalView {
    const job = this.state.jobs.find((item) => item.id === id)
    if (job?.state === 'refreshing') throw new Error('Brain changed; refreshing this review')
    if (job?.state !== 'review') throw new Error('Review not found')
    if (this.computedRevisions.get(id) !== this.state.revision) {
      // Recomputed as the same review: its first start stays, the attempt starts on a tick.
      Object.assign(job, { state: 'refreshing', runStartedAt: null, progress: null })
      throw new Error('Brain changed; refreshing this review')
    }
    const plain = mockBrainProposal(job, this.state.revision)
    const proposal = this.demo && job.id === 'harbor-demo-review' ? withDemoQuestions(plain) : plain
    if (job.replaces) {
      proposal.replacingMemories = this.history.memories(job.sessionId).length
      proposal.confirmations = []
      proposal.memories = proposal.memories.map((m) => ({ ...m, action: 'add', target: null }))
    }
    return proposal
  }
  private tick(): void {
    if (this.downloading !== null) {
      const phases = ['downloading', 'verifying', 'testing', 'ready'] as const
      const elapsed = this.now() - this.downloading
      this.state.embedding.phase = phases[Math.min(3, Math.floor(elapsed / 2000))]!
      this.state.embedding.receivedBytes = Math.min(
        this.state.embedding.totalBytes,
        (elapsed / 2000) * this.state.embedding.totalBytes,
      )
      if (this.state.embedding.phase === 'ready') this.downloading = null
    }
    if (!this.state.prefs.enabled || this.state.embedding.phase !== 'ready') return
    // One attempt at a time; a waiting refresh goes before any queued read, as on Desktop.
    const jobs = this.state.jobs
    const job =
      jobs.find((j) => j.runStartedAt !== null && ['running', 'refreshing'].includes(j.state)) ??
      jobs.find((j) => j.state === 'refreshing') ??
      jobs.find((j) => j.state === 'queued')
    if (!job) return
    if (job.state === 'queued' || job.runStartedAt === null) return this.start(job)
    if (this.now() - job.runStartedAt < 4000) return
    const refreshed = job.state === 'refreshing'
    Object.assign(job, { state: 'review', runStartedAt: null, progress: null })
    this.computedRevisions.set(job.id, this.state.revision)
    // A refresh recomputes the same review: same read, same record, same finish.
    if (refreshed) return
    job.finishedAt = this.now()
    this.records.set(job.id, this.extractionRecord(job.id))
    job.memories = 2
    if (!this.state.prefs.review)
      this.review(
        job.id,
        { descriptions: [], memories: [0, 1], identities: {}, groups: [] },
        this.state.revision,
      )
  }
  /** A read's first start freezes its model; every attempt, refresh included, restarts the clock. */
  private start(job: BrainJob): void {
    if (job.state === 'queued') {
      if (job.startedAt === null) {
        job.model = this.state.prefs.model ?? job.model
        this.records.set(job.id, {
          ...this.extractionRecord(job.id),
          thinking: this.state.prefs.model === null ? 'low' : 'medium',
        })
      }
      job.state = 'running'
      job.startedAt ??= this.now()
      job.progress = { stage: 'extract', done: 1, total: 4 }
    } else job.progress = { stage: 'reconcile', done: 1, total: 1 }
    job.runStartedAt = this.now()
  }
  private download(): BrainStatus {
    this.downloading = this.now()
    this.state.embedding.phase = 'downloading'
    return this.status()
  }
  /** Read again (`previous`) reads from the start; a lane read before continues after it. */
  private queue(lane: BrainLaneRef, previous?: BrainJob): BrainStatus {
    if (!this.state.prefs.enabled) throw new Error('Turn Brain on first.')
    if (
      this.state.jobs.some(
        (job) => job.sessionPath === lane.sessionPath && UNFINISHED.includes(job.state),
      )
    )
      throw new Error('This lane is already queued.')
    const earlier = this.history.jobs.find((job) => job.sessionPath === lane.sessionPath)
    const id = crypto.randomUUID()
    this.state.jobs.push(
      mockBrainJob({
        id,
        sessionPath: lane.sessionPath,
        title: lane.title,
        replaces: previous?.id ?? null,
        sessionId: previous?.sessionId ?? earlier?.sessionId ?? lane.sessionPath,
        state: 'queued',
        memories: 0,
        leafId: `leaf-${id}`,
        fromLeafId: previous ? null : (earlier?.leafId ?? null),
        queuedAt: this.now(),
        startedAt: null,
        finishedAt: null,
      }),
    )
    return this.status()
  }
  private extractionRecord(id: string): BrainExtractionView {
    const job = this.state.jobs.find((j) => j.id === id)!
    return mockExtractionRecord(job, this.records.get(id)?.thinking ?? 'low', this.now())
  }
  private mutation(channel: string, args: unknown[]): BrainStatus {
    switch (channel) {
      case 'brain:review':
        return this.review(
          args[0] as string,
          args[1] as BrainReviewDecision | null,
          args[2] as number,
        )
      case 'brain:reset':
        this.tidy.reset()
        this.explorer.entities = []
        this.explorer.details = []
        this.records.clear()
        this.history.jobs = []
        this.computedRevisions.clear()
        this.state.jobs = []
        this.state.revision = 0
        this.state.generation = `mock-generation-${++this.resets}`
        this.state.prefs.review = true
        return this.status()
      case 'brain:merge': {
        const operationId = this.tidy.merge(args[0] as string, args[1] as string, args[2] as number)
        this.state.revision++
        return Object.assign(this.status(), { operationId })
      }
      case 'brain:describe':
      case 'brain:removeName':
      case 'brain:split': {
        const operationId = this.tidy.edit(channel, args)
        this.state.revision++
        return Object.assign(this.status(), { operationId })
      }
      case 'brain:forget':
        this.tidy.forget(args[0] as string)
        this.explorer.details = this.explorer.details.filter(({ memory }) => memory.id !== args[0])
        break
      case 'brain:retry': {
        const job = this.state.jobs.find((j) => j.id === args[0] && j.state === 'failed')
        if (!job) throw new Error('Failed job not found')
        job.state = 'queued'
        job.error = null
        return this.status()
      }
      default:
        throw new Error(`Unknown Brain channel: ${channel}`)
    }
    this.state.revision++
    return this.status()
  }
  private extraction(id: string): BrainExtractionView {
    const record = this.records.get(id)
    if (!record) throw new Error('Brain extraction not found.')
    const memories = this.explorer.details
      .filter((d) => d.memory.jobId === record.jobId)
      .map(({ memory }) => ({ id: memory.id, summary: memory.summary }))
    return {
      ...record,
      job:
        this.state.jobs.find((j) => j.id === record.jobId) ??
        this.history.jobs.find((j) => j.id === record.jobId) ??
        null,
      laneMemories: this.history.memories(record.sessionId).length,
      replaceable: this.history.memories(record.sessionId).length,
      memories,
      outcomes: record.outcomes.map((outcome) => ({
        ...outcome,
        removed:
          !!outcome.memoryId &&
          !this.explorer.details.some((d) => d.memory.id === outcome.memoryId),
      })),
    }
  }
  call(channel: string, args: unknown[]): unknown {
    this.tick()
    if (channel.startsWith('brain:tidy')) return this.tidy.call(channel, args)
    switch (channel) {
      case 'brain:history':
        return this.history.history(args[0] as number)
      case 'brain:reread': {
        const previous = this.history.jobs.find((j) => j.id === args[0])
        if (!previous) throw new Error('Only finished Brain reads can be read again.')
        return this.queue(previous, previous)
      }
      case 'brain:status':
        return this.status()
      case 'brain:neverRead':
      case 'brain:setPrefs':
        this.state.prefs = mockBrainPrefs(channel, args, this.state.prefs)
        return channel === 'brain:setPrefs' &&
          this.state.prefs.enabled &&
          this.state.embedding.phase === 'missing'
          ? this.download()
          : this.status()
      case 'brain:download':
        return this.download()
      case 'brain:removeModel':
        if (this.state.prefs.enabled) throw new Error('Turn Brain off before removing the model.')
        this.downloading = null
        this.state.embedding.phase = 'missing'
        this.state.embedding.receivedBytes = 0
        return this.status()
      case 'brain:queue':
        return this.queue(args[0] as BrainLaneRef)
      case 'brain:cancel':
        this.state.jobs = this.state.jobs.filter((j) => j.id !== args[0])
        return this.status()
      case 'brain:proposal':
        return this.proposal(args[0] as string)
      case 'brain:extraction':
        return this.extraction(args[0] as string)
      case 'brain:find':
        return this.explorer.find(args[0] as string, args[1] as number)
      case 'brain:entities':
        return this.explorer.browse(
          args[0] as BrainEntityKind | null,
          args[1] as number,
          args[2] as number,
          args[3] as BrainEntitySort,
        )
      case 'brain:recent':
        return this.explorer.recent(args[0] as number, this.history.jobs)
      case 'brain:overview':
        return this.explorer.graph(null)
      case 'brain:neighbourhood':
        return this.explorer.graph(args[0] as string, args[1] as 1 | 2)
      case 'brain:entity':
        return this.explorer.entity(args[0] as string)
      case 'brain:connections':
        return this.explorer.connections(
          args[0] as string,
          args[1] as BrainPredicate,
          args[2] as 'out' | 'in',
          args[3] as string | null,
        )
      case 'brain:entityMemories':
        return this.explorer.memories(
          args[0] as string,
          args[1] as BrainMemoryFilter,
          args[2] as string | null,
        )
      case 'brain:memory':
        return this.explorer.memory(args[0] as string)
      case 'brain:path':
        return this.explorer.path(args[0] as string, args[1] as string)
      default:
        return this.mutation(channel, args)
    }
  }
}

/** Every local Brain channel; invented graph and clock-driven model/queue, no inference. */
export function createMockBrain(
  now: () => number = () => Date.now(),
  options: MockBrainOptions = {},
): (channel: string, args: unknown[]) => Promise<unknown> {
  const mock = new MockBrain(now, options)
  return async (channel, args) => structuredClone(mock.call(channel, args))
}
export const mockBrainCall = createMockBrain(() => Date.now(), {
  flagAfterMs: 20000,
  demoReviews: true,
})
