const unfaked = (): never => {
  throw new Error('Not faked')
}
import { BRAIN_READ_STALE } from '@phosphor/memory-engine/read-stale'
import { emptyBrainTidySummary, emptyBrainTidyCoverage } from '@phosphor/shared/brain-tidy'
import {
  DEFAULT_BRAIN_PREFS,
  type BrainExtractionRecord,
  type BrainJob,
  type BrainMemoryDetail,
  type BrainPrefs,
  type BrainProposalView,
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
  MemoryMatch,
  ClaimProbe,
} from '@phosphor/memory-engine/types'

export class FakeBrainStore implements BrainStore {
  prefs: BrainPrefs = { ...DEFAULT_BRAIN_PREFS }
  rev = 0
  knowledgeRev: number | null = null
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
      readSessionIds: this.jobs
        .filter((j) => ['done', 'empty', 'rejected'].includes(j.state))
        .map((j) => j.sessionId)
        .slice(-5000),
      jobs: this.jobs.filter((j) => !['done', 'rejected'].includes(j.state)).map((j) => ({ ...j })),
    }
  }
  revision(): number {
    return this.rev
  }
  knowledgeRevision(): number {
    return this.knowledgeRev ?? this.rev
  }
  setPrefs(prefs: BrainPrefs): BrainPrefs {
    return (this.prefs = { ...prefs })
  }
  enqueue(input: NewJob, state: 'waiting' | 'queued'): BrainJob {
    if (
      this.jobs.some(
        (j) =>
          j.sessionId === input.sessionId &&
          ['waiting', 'queued', 'running', 'refreshing', 'review'].includes(j.state),
      )
    )
      throw new Error('This lane is already queued.')
    const job: BrainJob = {
      ...input,
      replaces: input.replaces ?? null,
      id: `job-${++this.next}`,
      state,
      memories: 0,
      error: null,
      queuedAt: this.next,
      startedAt: null,
      runStartedAt: null,
      fromLeafId: input.replaces
        ? null
        : (this.jobs
            .filter(
              (j) =>
                j.sessionId === input.sessionId && ['done', 'empty', 'rejected'].includes(j.state),
            )
            .at(-1)?.leafId ?? null),
      finishedAt: null,
      usage: null,
      progress: null,
    }
    this.jobs.push(job)
    return job
  }
  history(limit: number) {
    const rows = this.jobs
      .filter((j) => ['done', 'empty', 'rejected'].includes(j.state))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    return {
      items: rows.slice(0, limit).map((job) => ({
        job,
        memories: this.laneMemories(job.sessionId).ids.length,
        replaceable: this.laneMemories(job.sessionId).replaceable.length,
      })),
      more: rows.length > limit,
    }
  }
  laneContext(sessionId: string): string[] {
    return this.oldMemories
      .filter((m) => m.origin?.sessionId === sessionId && m.state !== 'superseded')
      .slice(-60)
      .map((m) => m.summary)
  }
  laneMemories(sessionId: string, exceptJobId?: string) {
    const ids = this.oldMemories
      .filter((m) => m.origin?.sessionId === sessionId && m.jobId !== exceptJobId)
      .map((m) => m.id)
    return { ids, replaceable: ids }
  }
  job(id: string): BrainJob | undefined {
    return this.jobs.find((j) => j.id === id)
  }
  updateJob(id: string, patch: JobPatch): BrainJob {
    const job = this.job(id)
    if (!job) throw new Error('No job')
    for (const field of ['leafId', 'model', 'branch'] as const)
      if (patch[field] !== undefined && patch[field] !== job[field])
        throw new Error('Brain job metadata is frozen outside its first prepare checkpoint.')
    Object.assign(job, patch)
    if (job.state !== 'running' && job.state !== 'refreshing') job.runStartedAt = null
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
  part(id: string, part: string, hash?: string): JobPart | undefined {
    return hash === undefined
      ? [...this.parts.entries()].find(([key]) => key.startsWith(`${id}:${part}:`))?.[1]
      : this.parts.get(`${id}:${part}:${hash}`)
  }
  savePart(id: string, part: JobPart): void {
    if (part.part === 'prepare') {
      if (!part.prepare || part.inputHash !== 'frozen-v4')
        throw new Error('Prepare metadata required')
      const saved = this.part(id, 'prepare', 'frozen-v4')
      if (
        saved &&
        (saved.output !== part.output ||
          Object.entries(part.prepare).some(
            ([key, v]) => this.job(id)?.[key as keyof BrainJob] !== v,
          ))
      )
        throw new Error('Brain job metadata is frozen.')
      Object.assign(this.job(id)!, part.prepare)
    } else if (part.prepare) throw new Error('Only prepare can freeze metadata')
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
  memoryMatches(probes: ClaimProbe[], _limit: number): MemoryMatch[][] {
    return probes.map((_p, i) =>
      (this.matchesMemory[i] ?? []).map((id) => ({ id, channel: 'entity', similarity: 0 })),
    )
  }
  memoryCards(ids: string[]): MemoryCard[] {
    return this.oldMemories.filter((c) => ids.includes(c.id))
  }
  saved = new Map<string, Proposal>()
  saveRead(proposal: Proposal): ReturnType<BrainStore['saveRead']> {
    if (proposal.computedRevision !== this.knowledgeRevision()) throw new Error(BRAIN_READ_STALE)
    const memories = proposal.memories.filter((m) => m.hold !== 'personal').length
    const confirmed = proposal.confirmations.filter((c) => c.claim.hold !== 'personal').length
    const groups = proposal.groups.length
    const state = memories || confirmed || groups ? 'done' : 'empty'
    this.saved.set(proposal.jobId, proposal)
    this.updateJob(proposal.jobId, { state, memories })
    this.proposals.delete(proposal.jobId)
    this.rev++
    const claims = [...proposal.memories, ...proposal.confirmations.map((c) => c.claim)]
    return {state, memories, confirmed, groups, guesses: proposal.entities.filter((e) => e.decision === 'uncertain' && e.candidates.length).length,
      personal: claims.filter((m) => m.hold === 'personal').length,
      temporary: claims.filter((m) => m.hold === 'temporary').length,
      operationId: state === 'done' ? 'saved-read' : null, replaced: 0, touched: {entityIds: [], memoryIds: []}}
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
      replacingMemories: job.replaces ? this.laneMemories(job.sessionId, id).replaceable.length : 0,
      identities: p.entities.map((e) => ({
        ...e,
        required: false,
        candidates: this.entityCards(e.candidates),
      })),
      groups: p.groups.map((g, index) => ({ ...g, index, labels: [] })),
      memories: p.memories.map((m, index) => ({
        ...m,
        hold: null,
        index,
        quotes: [],
        links: [],
        target: m.target ? { id: m.target, summary: '' } : null,
      })),
      confirmations: p.confirmations.map((c) => ({
        id: c.memoryId,
        summary: '',
        claim: {
          ...c.claim,
          hold: null,
          target: null,
          links: c.claim.links.map((l) => ({ ...l, quote: l.citation.quote })),
          quotes: c.claim.citations.map((q) => ({
            quote: q.quote,
            before: '',
            after: '',
            label: p.evidence[q.evidence]!.label,
          })),
        },
      })),
      held: p.held,
    }
  }
  review(id: string, decision: BrainReviewDecision | null, revision: number): void {
    if (decision !== null && revision !== this.knowledgeRevision())
      throw new Error(BRAIN_READ_STALE)
    this.reviews.push({ id, decision })
    this.updateJob(id, {
      state: decision ? 'done' : 'rejected',
      memories: decision?.memories.length ?? 0,
    })
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
  tidySummary = emptyBrainTidySummary
  tidyChanges = () => ({ items: [], revision: this.rev })
  tidyUndo(): void {
    this.rev++
  }
  sweep = () => ({
    coverage: emptyBrainTidyCoverage(),
    suggestions: 0,
    folded: 0,
    operationIds: [],
  })
  takeTidyMaintenance = (): string[] => []
  flag = () => ({ status: 'filed' as const, suggestionId: 'flag' })
  // Brain Agent. FakeAgentStore and tests that exercise it replace these.
  waitingCounts: BrainStore['waitingCounts'] = () => ({
    reads: 0,
    entities: 0,
    repeats: 0,
    conflicts: 0,
    flags: 0,
  })
  waitingSuggestions: BrainStore['waitingSuggestions'] = () => ({ items: [], more: 0 })
  agentSuggestion: BrainStore['agentSuggestion'] = () => null
  decideRead: BrainStore['decideRead'] = (id, decision, revision) => {
    this.review(id, decision, revision)
    return { operationId: 'read-decision', touched: { entityIds: [], memoryIds: [] } }
  }
  resolve: BrainStore['resolve'] = unfaked
  agentEdit: BrainStore['agentEdit'] = unfaked
  correct: BrainStore['correct'] = unfaked
  erase: BrainStore['erase'] = unfaked
  agentUndo: BrainStore['agentUndo'] = unfaked
  createRun: BrainStore['createRun'] = unfaked
  updateRun: BrainStore['updateRun'] = unfaked
  latestRun: BrainStore['latestRun'] = () => null
  interruptRuns: BrainStore['interruptRuns'] = () => undefined
  undoRun: BrainStore['undoRun'] = unfaked
  merge(): string {
    this.rev++
    return 'operation'
  }
  describe(): string {
    this.rev++
    return 'operation'
  }
  removeName(): string {
    this.rev++
    return 'operation'
  }
  split(): string {
    this.rev++
    return 'operation'
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
export { FakeBrainSearch } from './fake-search'
export const HARBOR_JOB: NewJob = {
  sessionId: 'harbor-lane',
  sessionPath: '/made-up/harbor.jsonl',
  title: 'Harbor billing',
  scope: '/projects/harbor',
  branch: 'billing',
  model: 'example/fast',
  leafId: 'leaf',
}
