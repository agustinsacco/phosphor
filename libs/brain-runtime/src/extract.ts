import type { BrainJob, BrainJobStage } from '@phosphor/shared/brain'
import type { BrainStore, Proposal, ProposalEntity } from '@phosphor/memory-engine/types'
import type { BrainServiceOptions, BrainSearchPort } from './types'
import type { LaneMeta } from './lane'
import { isBrainReadStale } from '@phosphor/memory-engine/read-stale'
import { saveWithRecord, saveLegacy, afterReadSaved, type ReadOptions } from './extraction-save'
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
  options: ReadOptions,
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
    const stored = store.storedProposal(job.id)
    if (stored && stored.computedRevision === store.knowledgeRevision()) {
      const saved = saveLegacy(job, store, stored, options.now ?? Date.now)
      await afterReadSaved(saved.state, job, options, search)
      return
    }
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
  options: ReadOptions
  signal: AbortSignal
  search: BrainSearchPort
  record: ExtractionRecord
  ask: StageAsk
  progress(stage: BrainJobStage, done: number, total: number): void
}
async function finishExtraction(context: ExtractionContext, folded: FoldedJob): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Identity redirects, claim budgets and reconciliation mutate their input. Each attempt
    // must start from source claims, never from a previous revision's guesses.
    const job = structuredClone(folded)
    const proposal = await prepareProposal(context, job)
    let saved
    try {
      saved = saveWithRecord(
        context.store,
        context.record,
        proposal,
        [
          ...job.outcomes,
          ...job.claims.map((c, proposalIndex) => ({
            candidate: c.ref,
            summary: c.memory.summary,
            status: c.memory.action === 'enrich' ? ('enriches' as const) : ('kept' as const),
            proposalIndex,
          })),
        ],
        (context.options.now ?? Date.now)(),
      )
    } catch (error) {
      if (isBrainReadStale(error)) continue
      throw error
    }
    await afterReadSaved(saved.state, context.job, context.options, context.search)
    return
  }
  throw new Error('Brain kept changing while this lane was read. Retry it.')
}
async function prepareProposal(context: ExtractionContext, folded: FoldedJob): Promise<Proposal> {
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
    (options.now ?? Date.now)(),
  )
  progress('reconcile', 1, 1)
  recordClaims(context.record, folded)
  return embedProposal(context, folded, identity.entities, {
    computedRevision,
    groups,
    held,
    confirmations,
  })
}
async function embedProposal(
  context: ExtractionContext,
  folded: FoldedJob,
  entities: ProposalEntity[],
  fields: Pick<Proposal, 'computedRevision' | 'groups' | 'held' | 'confirmations'>,
): Promise<Proposal> {
  const { job, lane, store, options, signal, progress } = context
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
  progress('embed', 1, 1)
  return {
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
