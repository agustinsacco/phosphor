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
import { applyMockReview } from './mockReview'
import { MockExplorer } from './mockExplorer'
import { MockReadHistory } from './mockReadHistory'

class MockBrain {
  private state = mockBrainStatus()
  private explorer = new MockExplorer()
  private history = new MockReadHistory(this.explorer)
  private records = new Map<string, BrainExtractionView>()
  private downloading: number | null = null
  private resets = 0
  private computedRevisions = new Map<string, number>()
  private tidy: MockTidy
  constructor(
    private now: () => number,
    options: MockTidyOptions,
  ) {
    this.tidy = new MockTidy(this.explorer, this.state, now, options)
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
    return this.state
  }
  private review(id: string, decision: BrainReviewDecision | null, revision: number): BrainStatus {
    if (this.state.revision !== revision) throw new Error('Brain changed; refreshing this review')
    const proposal = this.proposal(id)
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
    if (decision || !proposal.job.replaces) this.history.finish(proposal.job, this.now())
    this.state.jobs = this.state.jobs.filter((item) => item.id !== id)
    this.state.revision++
    return this.status()
  }
  private proposal(id: string): BrainProposalView {
    const job = this.state.jobs.find((item) => item.id === id && item.state === 'review')
    if (!job) throw new Error('Review not found')
    if (this.computedRevisions.get(id) !== this.state.revision) {
      job.state = 'queued'
      job.startedAt = null
      job.finishedAt = null
      job.progress = null
      throw new Error('Brain changed; refreshing this review')
    }
    const proposal = mockBrainProposal(job, this.state.revision)
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
    const job = this.state.jobs.find((j) => ['queued', 'running'].includes(j.state))
    if (!job) return
    if (job.state === 'queued') {
      if (job.startedAt === null) {
        job.model = this.state.prefs.model ?? job.model
        this.records.set(job.id, {
          ...this.extractionRecord(job.id),
          thinking: this.state.prefs.model === null ? 'low' : 'medium',
        })
      }
      job.state = 'running'
      job.startedAt = this.now()
      job.progress = { stage: 'extract', done: 1, total: 4 }
      return
    }
    if (this.now() - (job.startedAt ?? this.now()) < 4000) return
    this.records.set(job.id, this.extractionRecord(job.id))
    job.state = 'review'
    this.computedRevisions.set(job.id, this.state.revision)
    job.progress = null
    job.memories = 2
    job.finishedAt = this.now()
    if (!this.state.prefs.review)
      this.review(
        job.id,
        { descriptions: [], memories: [0, 1], identities: {}, groups: [] },
        this.state.revision,
      )
  }
  private download(): BrainStatus {
    this.downloading = this.now()
    this.state.embedding.phase = 'downloading'
    return this.status()
  }
  private queue(lane: BrainLaneRef, previous?: BrainJob): BrainStatus {
    if (!this.state.prefs.enabled) throw new Error('Turn Brain on first.')
    if (this.state.jobs.some((job) => job.sessionPath === lane.sessionPath))
      throw new Error('This lane is already queued.')
    this.state.jobs.push(
      mockBrainJob({
        id: crypto.randomUUID(),
        ...lane,
        replaces: previous?.id ?? null,
        sessionId: previous?.sessionId ?? lane.sessionPath,
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
      job,
      replaceable: 0,
      laneMemories: 0,
      jobId: id,
      sessionId: job.sessionId,
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      model: job.model,
      thinking: this.records.get(id)?.thinking ?? 'low',
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
        {
          stage: 'links',
          part: 1,
          entryIds: ['s1'],
          inputHash: 'demo-links-hash',
          answer: JSON.stringify({
            links: [
              {
                claim: 'c1',
                subject: 'ledger',
                predicate: 'for_customer',
                object: 'harbor',
                segment: 's1',
                quote: 'Harbor Ledger is built for Harbor.',
              },
            ],
          }),
          trace: null,
          error: null,
        },
      ],
      prompts: [
        'Extract supported claims from this invented Harbor planning window.',
        'Find lasting relationships in the kept Harbor claims and their excerpts.',
      ],
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
  tidy: MockTidyOptions = {},
): (channel: string, args: unknown[]) => Promise<unknown> {
  const mock = new MockBrain(now, tidy)
  return async (channel, args) => structuredClone(mock.call(channel, args))
}
export const mockBrainCall = createMockBrain(() => Date.now(), { flagAfterMs: 20000 })
