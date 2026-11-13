import type {
  BrainExtractionView,
  BrainLaneRef,
  BrainMemoryFilter,
  BrainPrefs,
  BrainPredicate,
  BrainReviewDecision,
  BrainStatus,
} from '@shared/brain'
import { mockBrainJob, mockBrainProposal, mockBrainStatus } from './mockBrainData'
import { applyMockReview } from './mockReview'
import { MockExplorer } from './mockExplorer'

class MockBrain {
  private state = mockBrainStatus()
  private explorer = new MockExplorer()
  private records = new Map<string, BrainExtractionView>()
  private downloading: number | null = null
  private resets = 0
  constructor(private now: () => number) {
    this.state.jobs = [
      mockBrainJob({
        id: 'harbor-demo-review',
        sessionPath: '/demo/Harbor/planning-demo.jsonl',
        title: 'Harbor identity review',
      }),
      mockBrainJob({
        id: 'harbor-demo-failed',
        sessionPath: '/demo/Harbor/failed-demo.jsonl',
        title: 'Ledger extraction to retry',
        state: 'failed',
        error: 'Invented provider timeout · Retry resumes the same job',
      }),
    ]
    for (const job of this.state.jobs) this.records.set(job.id, this.extractionRecord(job.id))
  }
  private status(): BrainStatus {
    this.state.counts = {
      memories: this.explorer.details.length,
      entities: this.explorer.entities.length,
    }
    return this.state
  }
  private review(id: string, decision: BrainReviewDecision | null, revision: number): BrainStatus {
    if (this.state.revision !== revision) throw new Error('Brain changed; refreshing this review')
    const job = this.state.jobs.find((item) => item.id === id && item.state === 'review')
    if (!job) throw new Error('Review not found')
    const proposal = mockBrainProposal(job, revision)
    if (decision) applyMockReview(this.explorer, proposal, decision)
    this.state.jobs = this.state.jobs.filter((item) => item.id !== id)
    this.state.revision++
    return this.status()
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
    const job = this.state.jobs.find((j) => ['queued', 'running'].includes(j.state))
    if (!job) return
    if (job.state === 'queued') {
      job.state = 'running'
      job.startedAt = this.now()
      job.progress = { stage: 'extract', done: 1, total: 4 }
      return
    }
    if (this.now() - (job.startedAt ?? this.now()) < 4000) return
    this.records.set(job.id, this.extractionRecord(job.id))
    job.state = 'review'
    job.progress = null
    job.memories = 2
    job.finishedAt = this.now()
    if (!this.state.prefs.review)
      this.review(job.id, { memories: [0, 1], identities: {}, groups: [] }, this.state.revision)
  }
  private download(): BrainStatus {
    this.downloading = this.now()
    this.state.embedding.phase = 'downloading'
    return this.status()
  }
  private queue(lane: BrainLaneRef): BrainStatus {
    if (!this.state.prefs.enabled) throw new Error('Turn Brain on first.')
    if (this.state.jobs.some((job) => job.sessionPath === lane.sessionPath))
      throw new Error('This lane is already queued.')
    this.state.jobs.push(
      mockBrainJob({
        id: crypto.randomUUID(),
        ...lane,
        state: 'queued',
        memories: 0,
        queuedAt: this.now(),
        startedAt: null,
        finishedAt: null,
      }),
    )
    return this.status()
  }
  private extractionRecord(id: string): BrainExtractionView {
    const job = this.state.jobs.find((j) => j.id === id)!
    return {
      jobId: id,
      sessionId: job.sessionId,
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      model: job.model,
      thinking: 'low',
      calls: [
        {
          stage: 'extract',
          part: 1,
          entryIds: ['s1'],
          inputHash: 'demo-hash',
          answer: JSON.stringify({ claims: ['Harbor Ledger is built for Harbor.'] }),
          trace: null,
          error: null,
        },
      ],
      prompts: ['Extract supported links from this invented Harbor planning window.'],
      outcomes: [
        {
          candidate: 'w1:c1',
          summary: 'Harbor Ledger is built for Harbor.',
          status: 'kept',
          proposalIndex: 0,
        },
        {
          candidate: 'w1:c2',
          summary: 'Unverified ownership link',
          status: 'dropped',
          reason: 'Link quote not found in s1',
        },
      ],
      error: null,
      startedAt: job.startedAt ?? this.now(),
      finishedAt: this.now(),
      memories: [],
      source: {
        sessionPath: job.sessionPath,
        title: job.title,
        leafId: job.leafId,
        exists: false,
        segments: [],
      },
    }
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
        this.explorer.entities = []
        this.explorer.details = []
        this.records.clear()
        this.state.jobs = []
        this.state.revision = 0
        this.state.generation = `mock-generation-${++this.resets}`
        this.state.prefs.review = true
        return this.status()
      case 'brain:merge':
        this.explorer.merge(args[0] as string, args[1] as string)
        break
      case 'brain:forget':
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
  call(channel: string, args: unknown[]): unknown {
    this.tick()
    switch (channel) {
      case 'brain:status':
        return this.status()
      case 'brain:setPrefs':
        this.state.prefs = { ...(args[0] as BrainPrefs) }
        return this.state.prefs.enabled && this.state.embedding.phase === 'missing'
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
      case 'brain:proposal': {
        const job = this.state.jobs.find((j) => j.id === args[0] && j.state === 'review')
        if (!job) throw new Error('Review not found')
        return mockBrainProposal(job, this.state.revision)
      }
      case 'brain:extraction': {
        const record = this.records.get(args[0] as string)
        if (!record) throw new Error('Brain extraction not found.')
        const memories = this.explorer.details
          .filter((d) => d.memory.jobId === record.jobId)
          .map(({ memory }) => ({ id: memory.id, summary: memory.summary }))
        return {
          ...record,
          memories,
          outcomes: record.outcomes.map((outcome) => ({
            ...outcome,
            memoryId: memories.find((m) => m.summary === outcome.summary)?.id,
          })),
        }
      }
      case 'brain:find':
        return this.explorer.find(args[0] as string, args[1] as number)
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
): (channel: string, args: unknown[]) => Promise<unknown> {
  const mock = new MockBrain(now)
  return async (channel, args) => structuredClone(mock.call(channel, args))
}
export const mockBrainCall = createMockBrain()
