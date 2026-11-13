import type { BrainJob, BrainJobStage } from '@phosphor/shared/brain'
import type { BrainStore, Proposal } from '@phosphor/memory-engine/types'
import type { BrainServiceOptions, BrainSearchPort } from './types'
import { readLane, type LaneMeta } from './lane'
import { readEntries, transcriptSegments, transcriptAtLeaf } from './transcript'
import { transcriptWindows } from './windows'
import { callThinking } from './call-trace'
import { ExtractionRecord } from './extraction-record'
import { stageCaller } from './stage-call'
import { extractWindows } from './stages/extract'
import { foldParts } from './stages/fold'
import { resolveIdentities } from './stages/identity'
import { findParents, prefixGroups } from './stages/parents'
import { reconcile } from './stages/reconcile'
import { CLAIM_BUDGET } from './constants'
import { BRAIN_STRUCTURAL_PREDICATES } from '@phosphor/shared/brain'

async function frozenLane(job: BrainJob, store: BrainStore): Promise<LaneMeta> {
  const saved = store.part(job.id, 'prepare', 'frozen-v4')
  if (saved) return JSON.parse(saved.output) as LaneMeta
  const lane = await readLane(job.sessionPath)
  store.updateJob(job.id, { leafId: lane.leafId, model: lane.model, branch: lane.branch })
  store.savePart(job.id, { part: 'prepare', inputHash: 'frozen-v4', output: JSON.stringify(lane) })
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
    const parts = await extractWindows(
      job.id,
      transcriptWindows(segments),
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
    const computedRevision = store.revision()
    progress('identity', 0, 1)
    const entityVectors = await options.embeddings.embed(
      folded.entities.map((e) => `${e.label} (${e.kind}): ${e.description}`),
      'document',
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
    await findParents(folded, identity.entities, segments, store, ask)
    progress('parents', 1, 1)
    const groups = prefixGroups(folded, identity.entities)
    const held = applyBudget(folded)
    progress('reconcile', 0, 1)
    const vectors = await options.embeddings.embed(
      folded.claims.map((c) => c.memory.summary),
      'document',
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
    progress('embed', 0, 1)
    const memoryVectors = await options.embeddings.embed(
      folded.claims.map((c) => c.memory.summary),
      'document',
      signal,
    )
    const finalEntityVectors = await options.embeddings.embed(
      identity.entities.map((e) => `${e.label} (${e.kind}): ${e.description}`),
      'document',
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
      entities: identity.entities,
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
  } catch (error) {
    record?.failed(error)
    options.log?.('Brain extraction failed', {
      jobId: job.id,
      error: record?.record.error ?? 'Preparation failed',
    })
    throw error
  }
}
function applyBudget(job: ReturnType<typeof foldParts>): number {
  const priority = (c: (typeof job.claims)[number]): number =>
    c.memory.links.some((l) => BRAIN_STRUCTURAL_PREDICATES.some((p) => p === l.predicate))
      ? 0
      : ['decision', 'risk', 'open'].includes(c.memory.type)
        ? 1
        : 2
  const selected = new Set(
    [...job.claims].sort((a, b) => priority(a) - priority(b)).slice(0, CLAIM_BUDGET),
  )
  const held = job.claims.filter((c) => !selected.has(c))
  for (const c of held)
    job.outcomes.push({
      candidate: c.ref,
      summary: c.memory.summary,
      status: 'held',
      reason: 'Per-job 300 claim budget',
    })
  job.claims = job.claims.filter((c) => selected.has(c))
  return held.length
}
