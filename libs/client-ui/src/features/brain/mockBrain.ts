import type {
  BrainExtractionView,
  BrainKnowledge,
  BrainLaneRef,
  BrainMemoryDetail,
  BrainPrefs,
  BrainProposalView,
  BrainStatus,
} from '@shared/brain'
import { mockBrainData, mockBrainJob, mockBrainStatus } from './mockBrainData'

class MockBrain {
  private state = mockBrainStatus()
  private sample = mockBrainData()
  private records = new Map<string, BrainExtractionView>()
  private approved: BrainMemoryDetail[] = []
  private downloading: number | null = null
  constructor(private now: () => number) {}

  private knowledge(): BrainKnowledge {
    const ids = new Set(this.approved.flatMap(({ memory }) => [memory.subjectId, memory.objectId]))
    return {
      entities: this.sample.entities.filter((entity) => ids.has(entity.id)),
      memories: this.approved.map(({ memory }) => memory),
      truncated: false,
    }
  }

  private pruneRecords(): void {
    for (const [id, record] of this.records) {
      if (
        this.now() - record.finishedAt > 30 * 86_400_000 ||
        (!this.state.jobs.some((job) => job.id === id) &&
          !this.approved.some((detail) => detail.memory.jobId === id))
      )
        this.records.delete(id)
    }
  }
  private status(): BrainStatus {
    this.pruneRecords()
    this.state.counts = {
      memories: this.approved.length,
      entities: this.knowledge().entities.length,
    }
    return this.state
  }

  private review(id: string, keep: number[] | null, revision: number): BrainStatus {
    if (this.state.revision !== revision)
      throw new Error('Brain changed while you were reviewing. Reopen the review.')
    const job = this.state.jobs.find((item) => item.id === id)
    if (!job || job.state !== 'review') throw new Error('Review not found')
    this.approved.push(
      ...this.sample.details
        .filter((_, index) => keep?.includes(index))
        .map((detail) => ({
          ...detail,
          memory: {
            ...detail.memory,
            id: `${id}-${detail.memory.id}`,
            jobId: id,
            origin: { sessionId: job.sessionId, title: job.title },
          },
        })),
    )
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
    const active = this.state.jobs.find((job) => job.state === 'running' || job.state === 'queued')
    if (!active) return
    if (active.state === 'queued') {
      active.state = 'running'
      active.startedAt = this.now()
      return
    }
    if (this.now() - (active.startedAt ?? this.now()) < 4000) return
    this.records.set(active.id, this.extractionRecord(active.id))
    active.state = 'review'
    active.memories = this.sample.details.length
    active.finishedAt = this.now()
    if (!this.state.prefs.review) this.review(active.id, [0, 1], this.state.revision)
  }

  private download(): BrainStatus {
    this.downloading = this.now()
    this.state.embedding.phase = 'downloading'
    return this.status()
  }

  private setPrefs(prefs: BrainPrefs): BrainStatus {
    this.state.prefs = { ...prefs }
    return prefs.enabled && this.state.embedding.phase === 'missing'
      ? this.download()
      : this.status()
  }

  private removeModel(): BrainStatus {
    if (this.state.prefs.enabled) throw new Error('Turn Brain off before removing the model.')
    this.downloading = null
    this.state.embedding.phase = 'missing'
    this.state.embedding.receivedBytes = 0
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

  private proposal(id: unknown): BrainProposalView {
    const job = this.state.jobs.find((item) => item.id === id && item.state === 'review')
    if (!job) throw new Error('Review not found')
    return {
      job,
      summary: 'The lane settled Harbor’s billing database and migration ownership.',
      revision: this.state.revision,
      entities: this.sample.entities,
      memories: this.sample.details,
      confirmations: [],
    }
  }

  private extractionRecord(id: string): BrainExtractionView {
    const job = this.state.jobs.find((item) => item.id === id)
    if (!job) throw new Error('Brain extraction not found.')
    return {
      jobId: id,
      sessionId: job.sessionId,
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      model: job.model,
      thinking: 'low',
      prompt: 'Extract durable Harbor billing memories with verified quotes.',
      answer: JSON.stringify(
        { memories: this.sample.details.map((detail) => detail.memory.summary) },
        null,
        2,
      ),
      trace: null,
      outcomes: this.sample.details.map((detail, index) => ({
        candidate: index,
        summary: detail.memory.summary,
        status: 'kept',
        proposalIndex: index,
      })),
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
  private extraction(id: string): BrainExtractionView {
    this.pruneRecords()
    const record = this.records.get(id)
    if (!record) throw new Error('Brain extraction not found.')
    const memories = this.approved
      .filter((detail) => detail.memory.jobId === id)
      .map((detail) => ({
        id: detail.memory.id,
        summary: detail.memory.summary,
      }))
    return {
      ...record,
      memories,
      outcomes: record.outcomes.map((outcome) => ({
        ...outcome,
        memoryId: memories.find((memory) => memory.summary === outcome.summary)?.id,
      })),
    }
  }

  call(channel: string, args: unknown[]): unknown {
    this.tick()
    switch (channel) {
      case 'brain:status':
        return this.status()
      case 'brain:setPrefs':
        return this.setPrefs(args[0] as BrainPrefs)
      case 'brain:download':
        return this.download()
      case 'brain:removeModel':
        return this.removeModel()
      case 'brain:queue':
        return this.queue(args[0] as BrainLaneRef)
      case 'brain:cancel':
        this.state.jobs = this.state.jobs.filter((job) => job.id !== args[0])
        return this.status()
      case 'brain:extraction':
        return this.extraction(args[0] as string)
      case 'brain:proposal':
        return this.proposal(args[0])
      case 'brain:review':
        return this.review(args[0] as string, args[1] as number[] | null, args[2] as number)
      case 'brain:knowledge':
        return this.knowledge()
      case 'brain:memory': {
        const detail = this.approved.find(({ memory }) => memory.id === args[0])
        if (!detail) throw new Error('Memory not found')
        return detail
      }
      case 'brain:forget':
        this.approved = this.approved.filter(({ memory }) => memory.id !== args[0])
        this.state.revision++
        return this.status()
      default:
        throw new Error(`Unknown Brain channel: ${channel}`)
    }
  }
}

/** All local Brain channels, backed by invented notes and a clock-driven download/queue. */
export function createMockBrain(
  now: () => number = () => Date.now(),
): (channel: string, args: unknown[]) => Promise<unknown> {
  const mock = new MockBrain(now)
  return async (channel, args) => structuredClone(mock.call(channel, args))
}

export const mockBrainCall = createMockBrain()
