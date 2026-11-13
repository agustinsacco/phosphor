import {
  DEFAULT_BRAIN_PREFS,
  type BrainExtractionRecord,
  type BrainJob,
  type BrainMemoryDetail,
  type BrainPrefs,
  type BrainProposalView,
  type BrainRecall,
  type BrainSnapshot,
  type BrainReviewDecision,
  type BrainEntityView,
  type BrainPaths,
} from '@phosphor/shared/brain'
import type {
  BrainStore,
  Proposal,
  JobPatch,
  NewJob,
  JobPart,
  EntityMatch,
  EntityCard,
  MemoryCard,
  ClaimProbe,
  SearchInput,
} from '@phosphor/memory-engine/types'
import type { BrainSearchPort } from '../types'

export class FakeBrainStore implements BrainStore {
  prefs: BrainPrefs = { ...DEFAULT_BRAIN_PREFS }
  rev = 0
  generation = 'generation-1'
  jobs: BrainJob[] = []
  records = new Map<string, BrainExtractionRecord>()
  proposals = new Map<string, Proposal>()
  parts = new Map<string, JobPart>()
  details: BrainMemoryDetail[] = []
  cards: EntityCard[] = []
  oldMemories: MemoryCard[] = []
  matches: EntityMatch[][] = []
  matchesMemory: string[][] = []
  reviews: { id: string; decision: BrainReviewDecision | null }[] = []
  closed = false
  private next = 0
  snapshot(): BrainSnapshot {
    return {
      prefs: { ...this.prefs },
      revision: this.rev,
      generation: this.generation,
      counts: { memories: this.details.length, entities: this.cards.length },
      jobs: this.jobs.filter((j) => j.state !== 'done').map((j) => ({ ...j })),
    }
  }
  revision(): number {
    return this.rev
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
      progress: null,
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
  retry(id: string): BrainJob {
    if (this.job(id)?.state !== 'failed') throw new Error('Only failed jobs can be retried')
    return this.updateJob(id, { state: 'queued', error: null })
  }
  removeJob(id: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== id)
    this.proposals.delete(id)
    for (const [key] of this.parts) if (key.startsWith(id + ':')) this.parts.delete(key)
  }
  requeueInterrupted(): void {
    for (const job of this.jobs) if (job.state === 'running') job.state = 'queued'
  }
  part(id: string, part: string, hash: string): JobPart | undefined {
    return this.parts.get(`${id}:${part}:${hash}`)
  }
  savePart(id: string, part: JobPart): void {
    this.parts.set(`${id}:${part.part}:${part.inputHash}`, structuredClone(part))
  }
  entityMatches(
    probes: Parameters<BrainStore['entityMatches']>[0],
    _limit: number,
  ): EntityMatch[][] {
    return probes.map((_p, i) => this.matches[i] ?? [])
  }
  entityCards(ids: string[]): EntityCard[] {
    return this.cards.filter((c) => ids.includes(c.id))
  }
  neighbours(): ReturnType<BrainStore['neighbours']> {
    return []
  }
  memoryMatches(probes: ClaimProbe[], _limit: number): string[][] {
    return probes.map((_p, i) => this.matchesMemory[i] ?? [])
  }
  memoryCards(ids: string[]): MemoryCard[] {
    return this.oldMemories.filter((c) => ids.includes(c.id))
  }
  propose(proposal: Proposal) {
    this.proposals.set(proposal.jobId, proposal)
    this.updateJob(proposal.jobId, {
      state: proposal.memories.length || proposal.confirmations.length ? 'review' : 'empty',
      memories: proposal.memories.length,
    })
    return {
      memories: proposal.memories.length,
      confirmations: proposal.confirmations.length,
      identities: proposal.entities.length,
    }
  }
  storedProposal(id: string): Proposal | undefined {
    return this.proposals.get(id)
  }
  proposal(id: string): BrainProposalView {
    const p = this.proposals.get(id),
      job = this.job(id)
    if (!p || !job) throw new Error('No proposal')
    return {
      job,
      revision: p.computedRevision,
      identities: p.entities.map((e) => ({ ...e, candidates: this.entityCards(e.candidates) })),
      groups: p.groups.map((g, index) => ({ ...g, index, labels: [] })),
      memories: p.memories.map((m, index) => ({
        ...m,
        index,
        quotes: [],
        links: [],
        target: m.target ? { id: m.target, summary: '' } : null,
      })),
      confirmations: p.confirmations.map((c) => ({ id: c.memoryId, summary: '' })),
      held: p.held,
    }
  }
  review(id: string, decision: BrainReviewDecision | null, revision: number): void {
    if (revision !== this.rev)
      throw new Error('Brain changed while you were reviewing. Reopen the review.')
    this.reviews.push({ id, decision })
    this.updateJob(id, { state: 'done', memories: decision?.memories.length ?? 0 })
    this.proposals.delete(id)
    this.rev++
  }
  saveExtraction(record: BrainExtractionRecord): void {
    this.records.set(record.jobId, structuredClone(record))
  }
  extraction(id: string) {
    const r = this.records.get(id)
    if (!r) throw new Error('Brain extraction not found.')
    return { ...structuredClone(r), memories: [] }
  }
  overview() {
    return { nodes: [], links: [], centerId: null, truncated: false }
  }
  neighbourhood(id: string) {
    return { ...this.overview(), centerId: id }
  }
  entity(): BrainEntityView {
    throw new Error('No entity')
  }
  connections() {
    return { items: [], next: null }
  }
  entityMemories() {
    return { memories: [], entities: [], next: null }
  }
  memory(id: string): BrainMemoryDetail {
    const d = this.details.find((d) => d.memory.id === id)
    if (!d) throw new Error('No memory')
    return d
  }
  path(): BrainPaths {
    return { paths: [], entities: [], memories: [] }
  }
  merge(): void {
    this.rev++
  }
  forget(id: string): void {
    this.details = this.details.filter((d) => d.memory.id !== id)
    this.rev++
  }
  reset(): void {
    this.jobs = []
    this.parts.clear()
    this.proposals.clear()
    this.records.clear()
    this.details = []
    this.cards = []
    this.rev = 0
    this.generation += '-reset'
    this.prefs.review = true
  }
  close(): void {
    this.closed = true
  }
}
export class FakeBrainSearch implements BrainSearchPort {
  searches: SearchInput[] = []
  entityNeighbours: { id: string; score: number }[][] = []
  memoryNeighbours: { id: string; score: number }[][] = []
  refreshes = 0
  closed = false
  result: BrainRecall = {
    status: 'no_match',
    hits: [],
    entities: [],
    focus: [],
    paths: [],
    branch: null,
    more: 0,
    degradation: [],
  }
  async refresh() {
    this.refreshes++
  }
  async ready() {
    return true
  }
  async recall(input: SearchInput) {
    this.searches.push(input)
    return this.result
  }
  async find() {
    return { entities: [], memories: [], referenced: [], degradation: [] }
  }
  async nearestEntities(vectors: Float32Array[]) {
    return vectors.map((_v, i) => this.entityNeighbours[i] ?? [])
  }
  async nearestMemories(vectors: Float32Array[]) {
    return vectors.map((_v, i) => this.memoryNeighbours[i] ?? [])
  }
  async close() {
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
