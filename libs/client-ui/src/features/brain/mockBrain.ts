import { queueMockBrain } from './mockBrainQueue'
import { MOCK_BRAIN_SESSION, MockBrainAgent } from './mockBrainAgent'
import { MockTidy, type MockTidyOptions } from './tidy/mockTidy'
import { checkMockTidyArguments } from './tidy/mockTidyArguments'
import { mockBrainPrefs } from './mockBrainPrefs'
import type { BrainEntitySort } from '@shared/brain-explore'
import { brainLaneNeverRead } from '@shared/brain'
import type {
  BrainExtractionView,
  BrainEntityKind,
  BrainJob,
  BrainLaneRef,
  BrainMemoryFilter,
  BrainPredicate,
  BrainStatus,
} from '@shared/brain'
import { mockBrainStatus } from './mockBrainData'
import { mockDemoReads, mockStartingJobs } from './mockBrainDemo'
import { mockExtractionRecord } from './mockExtractionRecord'
import { MockExplorer } from './mockExplorer'
import { MockReads } from './mockReads'
import { mockAsk, mockRoutes } from './mockRecall'

export interface MockBrainOptions extends MockTidyOptions {
  /** The browser harness: two reads already saved and one about to be read. */
  demo?: boolean
  /** How long after a saved read the automatic Brain Agent run starts. */
  autoRunMs?: number
}
/** A mock read runs this long before it saves. */
const READ_MS = 4000

export class MockBrain {
  private state = mockBrainStatus()
  private explorer: MockExplorer
  private reads: MockReads
  private records = new Map<string, BrainExtractionView>()
  private downloading: number | null = null
  private resets = 0
  private tidy: MockTidy
  private agent: MockBrainAgent
  /** What `brain:tell` sent, newest last, so tests can see it. */
  told: string[] = []
  constructor(
    private now: () => number,
    options: MockBrainOptions,
  ) {
    this.explorer = new MockExplorer(now)
    this.tidy = new MockTidy(this.explorer, this.state, now, options)
    this.reads = new MockReads(this.explorer, this.tidy, now)
    this.agent = new MockBrainAgent(this.state, this.tidy, now, options.autoRunMs)
    this.state.jobs = mockStartingJobs()
    if (options.demo) {
      const { saved, queued } = mockDemoReads()
      for (const job of saved) this.finish(job)
      this.state.jobs.push(...queued)
    }
    for (const job of this.state.jobs) this.records.set(job.id, this.extractionRecord(job))
  }
  private status(): BrainStatus {
    this.tidy.tick()
    this.state.tidy = this.tidy.summary()
    this.state.agent.waiting = this.agent.waiting()
    this.state.counts = {
      memories: this.explorer.details.length,
      entities: this.explorer.entities.length,
    }
    if (this.state.ownerId && !this.explorer.entities.some((e) => e.id === this.state.ownerId))
      this.state.ownerId = null
    this.state.readSessionIds = [...new Set(this.reads.jobs.map((job) => job.sessionId))].slice(
      0,
      5000,
    )
    return this.state
  }
  /** A read saves when it finishes: one journal operation, then the automatic run may follow. */
  private finish(job: BrainJob): void {
    this.records.set(job.id, this.extractionRecord(job))
    this.reads.save(job)
    this.state.jobs = this.state.jobs.filter((item) => item.id !== job.id)
    const record = this.records.get(job.id)!
    for (const outcome of record.outcomes)
      outcome.memoryId = this.explorer.details.find((d) => d.memory.jobId === job.id)?.memory.id
    this.state.revision++
    this.agent.readSaved()
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
    this.agent.tick()
    if (this.agent.active()) return
    const jobs = this.state.jobs
    const job =
      jobs.find((j) => j.state === 'running') ??
      jobs.find((j) => j.state === 'queued' && this.agent.canRead(j.id))
    if (!job) return
    if (job.state === 'queued') return this.start(job)
    if (this.now() - (job.runStartedAt ?? 0) >= READ_MS) this.finish(job)
  }
  /** A read's first start freezes its model; every attempt restarts the clock. */
  private start(job: BrainJob): void {
    if (job.startedAt === null) job.model = this.state.prefs.model ?? job.model
    job.state = 'running'
    job.startedAt ??= this.now()
    job.progress = { stage: 'extract', done: 1, total: 4 }
    job.runStartedAt = this.now()
    this.records.set(job.id, {
      ...this.extractionRecord(job),
      thinking: this.state.prefs.model === null ? 'low' : 'medium',
    })
  }
  private download(): BrainStatus {
    this.downloading = this.now()
    this.state.embedding.phase = 'downloading'
    return this.status()
  }
  private queue(lane: BrainLaneRef, previous?: BrainJob): BrainStatus {
    queueMockBrain(lane, previous, this.state, this.reads, this.now)
    const job = this.state.jobs.at(-1)!
    this.records.set(job.id, this.extractionRecord(job))
    return this.status()
  }
  private setPrefs(channel: 'brain:neverRead' | 'brain:setPrefs', args: unknown[]): BrainStatus {
    this.state.prefs = mockBrainPrefs(channel, args, this.state.prefs)
    if (!this.state.prefs.enabled) this.agent.call('brain:defragStop', [])
    // As on Desktop, a rule change drops reads not yet started.
    this.state.jobs = this.state.jobs.filter(
      (job) =>
        !['queued', 'waiting'].includes(job.state) ||
        !brainLaneNeverRead(this.state.prefs.neverRead, job),
    )
    return channel === 'brain:setPrefs' &&
      this.state.prefs.enabled &&
      this.state.embedding.phase === 'missing'
      ? this.download()
      : this.status()
  }
  private extractionRecord(job: BrainJob): BrainExtractionView {
    return mockExtractionRecord(job, this.records.get(job.id)?.thinking ?? 'low', this.now())
  }
  private mutation(channel: string, args: unknown[]): BrainStatus {
    switch (channel) {
      case 'brain:reset':
        this.tidy.reset()
        this.explorer.entities = []
        this.explorer.details = []
        this.records.clear()
        this.reads.jobs = []
        this.state.jobs = []
        this.state.agent.run = null
        this.state.ownerId = null
        this.state.revision = 0
        this.state.generation = `mock-generation-${++this.resets}`
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
        if (!job) throw new Error('Only failed Brain jobs can be retried.')
        job.state = 'queued'
        job.error = null
        return this.status()
      }
      case 'brain:setOwner': {
        const id = args[0] as string | null
        if (id !== null) this.explorer.entity(id)
        this.state.ownerId = id
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
    const lane = this.reads.laneRead(record.sessionId)
    return {
      ...record,
      job:
        this.state.jobs.find((j) => j.id === record.jobId) ??
        this.reads.jobs.find((j) => j.id === record.jobId) ??
        null,
      laneMemories: lane?.memories ?? 0,
      replaceable: lane?.replaceable ?? 0,
      memories,
      outcomes: record.outcomes.map((outcome) => ({
        ...outcome,
        removed:
          !!outcome.memoryId &&
          !this.explorer.details.some((d) => d.memory.id === outcome.memoryId),
      })),
    }
  }
  private reread(id: string): BrainStatus {
    const previous = this.reads.jobs.find((j) => j.id === id)
    if (!previous) throw new Error('Only finished Brain reads can be read again.')
    return this.queue(previous, previous)
  }
  private explore(channel: string, args: unknown[]): unknown {
    switch (channel) {
      case 'brain:find':
        return this.explorer.find(args[0] as string, args[1] as number)
      case 'brain:entities':
        return this.explorer.browse(
          args[0] as BrainEntityKind | null,
          args[1] as number,
          args[2] as number,
          args[3] as BrainEntitySort,
        )
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
        return mockRoutes(this.explorer, args[0] as string, args[1] as string)
      case 'brain:ask':
        return mockAsk(this.explorer, (args[0] as string).trim())
      default:
        return this.mutation(channel, args)
    }
  }
  call(channel: string, args: unknown[]): unknown {
    checkMockTidyArguments(channel, args)
    this.tick()
    if (['brain:defrag', 'brain:defragStop', 'brain:undoRun'].includes(channel)) {
      const result = this.agent.call(channel, args)
      return Object.assign(this.status(), result)
    }
    if (['brain:tidyChanges', 'brain:tidyUndo'].includes(channel))
      return this.tidy.call(channel, args)
    switch (channel) {
      case 'brain:status':
        return this.status()
      case 'brain:neverRead':
      case 'brain:setPrefs':
        return this.setPrefs(channel, args)
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
      case 'brain:reread':
        return this.reread(args[0] as string)
      case 'brain:cancel':
        this.state.jobs = this.state.jobs.filter((j) => j.id !== args[0])
        return this.status()
      case 'brain:extraction':
        return this.extraction(args[0] as string)
      case 'brain:laneRead':
        return this.reads.laneRead(args[0] as string)
      case 'brain:tell':
        if (!this.state.prefs.enabled) throw new Error('Turn Brain on first.')
        this.told.push((args[0] as string).trim())
        return { sessionPath: MOCK_BRAIN_SESSION }
      default:
        return this.explore(channel, args)
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
  demo: true,
  autoRunMs: 8000,
})
