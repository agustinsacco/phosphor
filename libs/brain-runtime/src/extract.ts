import type { BrainJob, BrainJobStage } from '@phosphor/shared/brain'
import type { BrainStore, Proposal, ProposalEntity } from '@phosphor/memory-engine/types'
import type { BrainServiceOptions, BrainSearchPort } from './types'
import type { LaneMeta } from './lane'
import { prepareRead } from './prepare-read'
import { incrementalSegments, withoutOverlapClaims } from './incremental'
import type { LaneEntry } from './transcript'
import { transcriptWindows } from './windows'
import { callThinking } from './call-trace'
import { ExtractionRecord } from './extraction-record'
import { stageCaller } from './stage-call'
import { extractWindows } from './stages/extract'
import { foldParts, type FoldedJob } from './stages/fold'
import { resolveIdentities } from './stages/identity'
import { prefixGroups } from './stages/groups'
import { reconcile } from './stages/reconcile'
import { applyClaimBudget } from './stages/budget'
import type { StageAsk } from './stage-types'
import { EMBEDDING_MAX_TEXTS } from './embedding/model-manifest'

export async function extractJob(
  job: BrainJob,
  signal: AbortSignal,
  store: BrainStore,
  options: BrainServiceOptions,
  search: BrainSearchPort,
  /** The transcript the queue's start check read, if it had to. */
  checked?: LaneEntry[],
): Promise<void> {
  let record: ExtractionRecord | undefined
  const progress = (stage: BrainJobStage, done: number, total: number): void => {
    signal.throwIfAborted()
    store.updateJob(job.id, { progress: { stage, done, total } })
    options.onChange?.()
  }
  try {
    progress('prepare', 0, 1)
    const { lane, entries } = await prepareRead(job, store, checked)
    record = new ExtractionRecord(
      { ...job, leafId: lane.leafId, model: lane.model, branch: lane.branch },
      store,
      options.now ?? Date.now,
      callThinking(lane.thinking),
    )
    const { source, selected } = incrementalSegments(entries, lane.leafId, lane.fromLeafId ?? null)
    progress('prepare', 1, 1)
    const ask = await stageCaller({ job, lane, store, options, signal, record })
    const windows = selected.some((s) => s.role !== 'context') ? transcriptWindows(selected) : []
    progress('extract', 0, windows.length)
    const parts = await extractWindows(
      job.id,
      windows,
      store,
      ask,
      (done, total) => progress('extract', done, total),
      source,
      lane.alreadyKept ?? [],
    )
    const folded = foldParts(parts.map(withoutOverlapClaims), lane.sessionId)
    if (lane.branched)
      folded.outcomes.unshift({
        candidate: 'read:branch',
        summary: 'Lane branched since its previous read',
        status: 'dropped',
        reason: lane.fromLeafId
          ? `Reading new messages after common ancestor ${lane.fromLeafId}`
          : 'No shared ancestor remains; reading from the beginning',
      })
    if (job.fromLeafId !== null) {
      const mentioned = new Set(folded.claims.flatMap((c) => c.memory.entities))
      folded.entities = folded.entities.filter((e) => mentioned.has(e.ref))
    }
    recordClaims(record, folded)
    await finishExtraction(
      { job, lane, store, options, signal, search, record, progress, ask },
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
  ask: StageAsk
  progress(stage: BrainJobStage, done: number, total: number): void
}
async function finishExtraction(context: ExtractionContext, folded: FoldedJob): Promise<void> {
  const { store, options, signal, search, ask, progress } = context
  const computedRevision = store.knowledgeRevision()
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
    context.job.replaces
      ? store.laneMemories(context.job.sessionId, context.job.id).replaceable
      : [],
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
/** With review off, held claims are never saved and a required question keeps the read in review. */
async function approveWithoutReview(context: ExtractionContext, proposal: Proposal): Promise<void> {
  const { job, store, options, search } = context
  if (
    store.snapshot().prefs.review ||
    store.job(job.id)?.state !== 'review' ||
    proposal.entities.some((entity) => entity.required)
  )
    return
  store.review(
    job.id,
    {
      memories: proposal.memories.flatMap((memory, i) => (memory.hold ? [] : [i])),
      identities: {},
      groups: [],
      descriptions: [],
      // Held confirmations wait for a tick, and nobody ticks with review off.
      confirmations: [],
    },
    proposal.computedRevision,
  )
  // The result is saved. A failed index refresh must not turn a finished read into a failure.
  await search.refresh().catch((error: unknown) => {
    options.log?.('Brain search refresh failed after saving', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}
async function embedAndPropose(
  context: ExtractionContext,
  folded: FoldedJob,
  entities: ProposalEntity[],
  fields: Pick<Proposal, 'computedRevision' | 'groups' | 'held' | 'confirmations'>,
): Promise<void> {
  const { job, lane, store, options, signal, record, progress } = context
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
  await approveWithoutReview(context, proposal)
  options.log?.('Brain extraction finished', {
    jobId: job.id,
    calls: record.record.calls.length,
    memories: proposal.memories.length,
    held,
  })
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
