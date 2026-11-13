import type { BrainJob, BrainJobStage } from '@phosphor/shared/brain'
import type {
  BrainStore,
  Proposal,
  ProposalEntity,
  TranscriptSegment,
} from '@phosphor/memory-engine/types'
import type { BrainServiceOptions, BrainSearchPort } from './types'
import { readLane, type LaneMeta } from './lane'
import { readEntries, transcriptSegments, transcriptAtLeaf } from './transcript'
import { transcriptWindows } from './windows'
import { callThinking } from './call-trace'
import { ExtractionRecord } from './extraction-record'
import { stageCaller } from './stage-call'
import { extractWindows } from './stages/extract'
import { foldParts, type FoldedJob } from './stages/fold'
import { resolveIdentities } from './stages/identity'
import { findParents, prefixGroups } from './stages/parents'
import { reconcile } from './stages/reconcile'
import { applyClaimBudget } from './stages/budget'
import type { StageAsk } from './stage-types'
import { EMBEDDING_MAX_TEXTS } from './embedding/model-manifest'

async function frozenLane(job: BrainJob, store: BrainStore): Promise<LaneMeta> {
  const saved = store.part(job.id, 'prepare', 'frozen-v4')
  if (saved) return JSON.parse(saved.output) as LaneMeta
  const lane = await readLane(job.sessionPath)
  store.savePart(job.id, {
    part: 'prepare',
    inputHash: 'frozen-v4',
    output: JSON.stringify(lane),
    prepare: { leafId: lane.leafId, model: lane.model, branch: lane.branch },
  })
  return lane
}
export async function extractJob(
  job: BrainJob,
  signal: AbortSignal,
  store: BrainStore,
  options: BrainServiceOptions,
  search: BrainSearchPort,
): Promise<void> {
  let record: ExtractionRecord | undefined
  const progress = (stage: BrainJobStage, done: number, total: number): void => {
    signal.throwIfAborted()
    store.updateJob(job.id, { progress: { stage, done, total } })
    options.onChange?.()
  }
  try {
    progress('prepare', 0, 1)
    const lane = await frozenLane(job, store)
    record = new ExtractionRecord(
      { ...job, leafId: lane.leafId, model: lane.model, branch: lane.branch },
      store,
      options.now ?? Date.now,
      callThinking(lane.thinking, 'extract'),
    )
    const segments = transcriptSegments(
      transcriptAtLeaf(await readEntries(job.sessionPath), lane.leafId),
    )
    progress('prepare', 1, 1)
    const ask = await stageCaller({ job, lane, store, options, signal, record })
    const windows = transcriptWindows(segments)
    progress('extract', 0, windows.length)
    const parts = await extractWindows(
      job.id,
      windows,
      store,
      ask,
      (done, total) => progress('extract', done, total),
      segments,
    )
    const folded = foldParts(parts, lane.sessionId)
    for (const part of parts.filter((p) => p.truncated))
      folded.outcomes.push({
        candidate: part.key,
        summary: 'Single-segment window reached the extraction cap',
        status: 'held',
        reason: 'Extraction may be truncated at 40 claims/entities',
      })
    recordClaims(record, folded)
    await finishExtraction(
      { job, lane, store, options, signal, search, record, progress, segments, ask },
      folded,
    )
  } catch (error) {
    record?.failed(error)
    options.log?.('Brain extraction failed', {
      jobId: job.id,
      error: record?.record.error ?? 'Preparation failed',
    })
    throw error
  }
}

interface ExtractionContext {
  job: BrainJob
  lane: LaneMeta
  store: BrainStore
  options: BrainServiceOptions
  signal: AbortSignal
  search: BrainSearchPort
  record: ExtractionRecord
  segments: TranscriptSegment[]
  ask: StageAsk
  progress(stage: BrainJobStage, done: number, total: number): void
}
async function finishExtraction(context: ExtractionContext, folded: FoldedJob): Promise<void> {
  const { store, options, signal, search, ask, segments, progress } = context
  const computedRevision = store.revision()
  progress('identity', 0, 1)
  const entityVectors = await embedDocuments(
    options,
    folded.entities.map((e) => `${e.label} (${e.kind}): ${e.description}`),
    signal,
  )
  const identity = await resolveIdentities(
    folded,
    store,
    search,
    entityVectors.map((v) => new Float32Array(v)),
    ask,
  )
  progress('identity', 1, 1)
  progress('parents', 0, 1)
  const priorRefs = new Set(identity.entities.map((e) => e.ref))
  await findParents(context.job.id, folded, identity.entities, segments, store, ask)
  recordClaims(context.record, folded)
  await resolveParentIdentities(context, folded, identity.entities, priorRefs)
  progress('parents', 1, 1)
  const groups = prefixGroups(folded, identity.entities, store)
  const held = applyClaimBudget(folded)
  progress('reconcile', 0, 1)
  const vectors = await embedDocuments(
    options,
    folded.claims.map((c) => c.memory.summary),
    signal,
  )
  const confirmations = await reconcile(
    folded,
    identity.entities,
    store,
    search,
    vectors.map((v) => new Float32Array(v)),
    ask,
  )
  progress('reconcile', 1, 1)
  recordClaims(context.record, folded)
  await embedAndPropose(context, folded, identity.entities, {
    computedRevision,
    groups,
    held,
    confirmations,
  })
}
async function embedAndPropose(
  context: ExtractionContext,
  folded: FoldedJob,
  entities: ProposalEntity[],
  fields: Pick<Proposal, 'computedRevision' | 'groups' | 'held' | 'confirmations'>,
): Promise<void> {
  const { job, lane, store, options, signal, search, record, progress } = context
  const { computedRevision, groups, held, confirmations } = fields
  progress('embed', 0, 1)
  const memoryVectors = await embedDocuments(
    options,
    folded.claims.map((c) => c.memory.summary),
    signal,
  )
  const finalEntityVectors = await embedDocuments(
    options,
    entities.map((e) => `${e.label} (${e.kind}): ${e.description}`),
    signal,
  )
  signal.throwIfAborted()
  if (!store.job(job.id)) throw new Error('Knowledge extraction job removed.')
  const proposal: Proposal = {
    jobId: job.id,
    origin: { sessionId: lane.sessionId, title: job.title },
    scope: lane.scope,
    branch: lane.branch,
    computedRevision,
    entities: entities,
    memories: folded.claims.map((c) => c.memory),
    groups,
    confirmations,
    evidence: folded.evidence,
    held,
    memoryVectors: memoryVectors.map((v) => new Float32Array(v)),
    entityVectors: finalEntityVectors.map((v) => new Float32Array(v)),
  }
  store.propose(proposal)
  record.outcomes([
    ...folded.outcomes,
    ...folded.claims.map((c, i) => ({
      candidate: c.ref,
      summary: c.memory.summary,
      status: c.memory.action === 'enrich' ? ('enriches' as const) : ('kept' as const),
      proposalIndex: i,
    })),
  ])
  store.updateJob(job.id, {
    finishedAt: (options.now ?? Date.now)(),
    progress: { stage: 'embed', done: 1, total: 1 },
  })
  if (!store.snapshot().prefs.review && store.job(job.id)?.state === 'review') {
    store.review(
      job.id,
      { memories: proposal.memories.map((_m, i) => i), identities: {}, groups: [] },
      computedRevision,
    )
    await search.refresh()
  }
  options.log?.('Brain extraction finished', {
    jobId: job.id,
    calls: record.record.calls.length,
    memories: proposal.memories.length,
    held,
  })
}

async function resolveParentIdentities(
  context: ExtractionContext,
  job: FoldedJob,
  identities: ProposalEntity[],
  prior: Set<string>,
): Promise<void> {
  const introduced = job.entities.filter((e) => !prior.has(e.ref))
  if (!introduced.length) return
  const anchors = identities.filter((e) => prior.has(e.ref))
  const subset = { ...job, entities: introduced, outcomes: job.outcomes }
  const vectors = await embedDocuments(
    context.options,
    introduced.map((e) => `${e.label} (${e.kind}): ${e.description}`),
    context.signal,
  )
  const ask: StageAsk = (stage, part, prompt, validate, entryIds, input) =>
    context.ask(stage, part, prompt, validate, entryIds, { ...input, pass: 'parents' })
  const result = await resolveIdentities(
    subset,
    context.store,
    context.search,
    vectors.map((v) => new Float32Array(v)),
    ask,
    job.entities,
    anchors,
  )
  identities.splice(0, identities.length, ...anchors, ...result.entities)
  job.entities = identities
  job.claims = subset.claims
  job.parents = subset.parents
}

function recordClaims(record: ExtractionRecord, job: FoldedJob): void {
  record.outcomes([
    ...job.outcomes,
    ...job.claims.map((c) => ({
      candidate: c.ref,
      summary: c.memory.summary,
      status: 'dropped' as const,
      reason: 'Run failed before proposal',
    })),
  ])
}

async function embedDocuments(
  options: BrainServiceOptions,
  texts: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += EMBEDDING_MAX_TEXTS) {
    signal.throwIfAborted()
    vectors.push(
      ...(await options.embeddings.embed(
        texts.slice(i, i + EMBEDDING_MAX_TEXTS),
        'document',
        signal,
      )),
    )
  }
  return vectors
}
