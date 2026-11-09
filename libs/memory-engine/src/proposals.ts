import type { BrainMemory, BrainProposalView } from '@phosphor/shared/brain'
import { all, one, run, transaction, type Context } from './database'
import { entity, referencedEntities } from './entities'
import { job, updateJob } from './jobs'
import { quoteContext } from './knowledge'
import { revision } from './prefs'
import type { Extraction } from './types'
import { cosine, decodeVector, encodeVector } from './vectors'

export function readProposal(ctx: Context, jobId: string): Extraction {
  const row = one<{ extraction: string }>(
    ctx,
    'SELECT extraction FROM proposals WHERE job_id=?',
    jobId,
  )
  if (!row) throw new Error('Brain proposal not found.')
  const extraction = JSON.parse(row.extraction) as Extraction
  extraction.vectors = all<{ vector: Uint8Array }>(
    ctx,
    'SELECT vector FROM proposal_vectors WHERE job_id=? ORDER BY idx',
    jobId,
  ).map((row) => decodeVector(row.vector))
  return extraction
}
export function propose(
  ctx: Context,
  extraction: Extraction,
): { kept: number; duplicates: number } {
  if (!job(ctx, extraction.jobId)) throw new Error('Brain job not found.')
  const active = all<{ memory_id: string; vector: Uint8Array }>(
    ctx,
    "SELECT v.* FROM vectors v JOIN memories m ON m.id=v.memory_id WHERE m.state='active'",
  ).map((row) => ({ id: row.memory_id, vector: decodeVector(row.vector) }))
  const vectors: Float32Array[] = []
  const memories = extraction.memories.filter((item, index) => {
    const vector = extraction.vectors[index]
    if (!vector) throw new Error('Brain proposal is missing a vector.')
    encodeVector(vector)
    const duplicate =
      active.some((old) => old.id !== item.supersedes && cosine(vector, old.vector) >= 0.86) ||
      vectors.some((old) => cosine(vector, old) >= 0.86)
    if (duplicate) return false
    vectors.push(vector)
    return true
  })
  transaction(ctx, () => {
    run(ctx, 'DELETE FROM proposals WHERE job_id=?', extraction.jobId)
    if (memories.length) {
      run(
        ctx,
        'INSERT INTO proposals VALUES (?,?)',
        extraction.jobId,
        JSON.stringify({
          ...extraction,
          entities: withReused(ctx, extraction, memories),
          memories,
          vectors: [],
        }),
      )
      vectors.forEach((vector, index) =>
        run(
          ctx,
          'INSERT INTO proposal_vectors VALUES (?,?,?)',
          extraction.jobId,
          index,
          encodeVector(vector),
        ),
      )
    }
    updateJob(ctx, extraction.jobId, {
      state: memories.length ? 'review' : 'empty',
      memories: memories.length,
    })
  })
  return { kept: memories.length, duplicates: extraction.memories.length - memories.length }
}
/** Forgetting can delete an entity a pending proposal reuses; approval recreates it from this copy. */
function withReused(
  ctx: Context,
  extraction: Extraction,
  memories: Extraction['memories'],
): Extraction['entities'] {
  const keys = new Set(extraction.entities.map((item) => item.key))
  const reused = [...new Set(memories.flatMap((item) => [item.subject, item.object]))].flatMap(
    (key) => {
      const found = key && !keys.has(key) ? entity(ctx, key) : undefined
      return found
        ? [{ key: found.id, label: found.label, kind: found.kind, aliases: found.aliases }]
        : []
    },
  )
  return [...extraction.entities, ...reused]
}
export function proposedMemory(
  extraction: Extraction,
  index: number,
  recordedAt: number,
): BrainMemory {
  const item = extraction.memories[index]!
  return {
    id: `${extraction.jobId}:${index}`,
    summary: item.summary,
    type: item.type,
    kind: item.kind,
    subjectId: item.subject,
    predicate: item.predicate,
    objectId: item.object,
    literal: item.literal,
    scope: extraction.scope,
    branch: item.branch ? extraction.branch : null,
    validFrom: item.validFrom,
    recordedAt,
    observedAt:
      Math.max(0, ...item.citations.map((c) => extraction.evidence[c.evidence]?.observedAt ?? 0)) ||
      recordedAt,
    origin: extraction.origin,
  }
}
export function proposal(ctx: Context, jobId: string): BrainProposalView {
  const extraction = readProposal(ctx, jobId)
  const current = job(ctx, jobId)!
  const memories = extraction.memories.map((item, index) => ({
    memory: proposedMemory(extraction, index, current.finishedAt ?? ctx.now()),
    quotes: item.citations.map((citation) => {
      const evidence = extraction.evidence[citation.evidence]
      if (!evidence) throw new Error('Brain citation evidence not found.')
      return quoteContext(citation.quote, evidence)
    }),
  }))
  const proposedEntities = extraction.entities.map(({ key, ...item }) => ({ ...item, id: key }))
  const ids = new Set(memories.flatMap(({ memory }) => [memory.subjectId, memory.objectId]))
  const existing = referencedEntities(
    ctx,
    memories.map(({ memory }) => memory),
  )
  const allEntities = new Map([...existing, ...proposedEntities].map((item) => [item.id, item]))
  return {
    job: current,
    summary: extraction.summary,
    revision: revision(ctx),
    memories,
    entities: [...allEntities.values()].filter((item) => ids.has(item.id)),
  }
}
