import { one, run, transaction, type Context } from './database'
import { cleanOrphans, entity, rebuildFts, resolveEntity } from './entities'
import { linkOutcome, pruneExtractions } from './extractions'
import { updateJob } from './jobs'
import { bumpRevision, revision } from './prefs'
import { readProposal } from './proposals'
import type { Extraction } from './types'
import { encodeVector } from './vectors'

export function review(
  ctx: Context,
  jobId: string,
  keep: number[] | null,
  expectedRevision: number,
): void {
  transaction(ctx, () => {
    if (expectedRevision !== revision(ctx)) {
      throw new Error('Brain changed while you were reviewing. Reopen the review.')
    }
    const extraction = readProposal(ctx, jobId)
    const indexes = [...new Set(keep ?? [])]
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= extraction.memories.length) {
        throw new Error('Brain proposal memory index is invalid.')
      }
    }
    const resolve = entityResolver(ctx, extraction)
    const evidence = new Map<number, string>()
    for (const index of indexes) insertMemory(ctx, extraction, index, resolve, evidence)
    const confirms = keep !== null && (indexes.length > 0 || extraction.memories.length === 0)
    if (confirms) applyConfirmations(ctx, extraction)
    if (indexes.length || (confirms && extraction.confirmations?.length)) {
      cleanOrphans(ctx)
      rebuildFts(ctx)
      bumpRevision(ctx)
    }
    updateJob(ctx, jobId, { state: 'done', memories: indexes.length, finishedAt: ctx.now() })
    run(ctx, 'DELETE FROM proposals WHERE job_id=?', jobId)
    pruneExtractions(ctx)
  })
}
function entityResolver(ctx: Context, extraction: Extraction): (key: string) => string {
  const resolved = new Map<string, string>()
  return (key) => {
    const cached = resolved.get(key)
    if (cached) return cached
    const raw = extraction.entities.find((item) => item.key === key)
    const id = raw ? resolveEntity(ctx, raw) : entity(ctx, key)?.id
    if (!id) throw new Error('Brain proposal entity not found.')
    resolved.set(key, id)
    return id
  }
}
function insertMemory(
  ctx: Context,
  extraction: Extraction,
  index: number,
  resolve: (key: string) => string,
  evidence: Map<number, string>,
): void {
  const item = extraction.memories[index]!
  const subject = resolve(item.subject)
  const object = item.object ? resolve(item.object) : null
  const id = ctx.id()
  run(
    ctx,
    `INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
    id,
    extraction.scope,
    subject,
    item.predicate,
    object,
    item.literal,
    item.summary,
    item.type,
    item.kind,
    item.branch ? extraction.branch : null,
    item.validFrom,
    ctx.now(),
    extraction.origin.sessionId,
    extraction.origin.title,
    extraction.jobId,
  )
  run(ctx, 'INSERT INTO vectors VALUES (?,?)', id, encodeVector(extraction.vectors[index]!))
  linkOutcome(ctx, extraction.jobId, index, id)
  insertCitations(ctx, id, item.citations, extraction.evidence, evidence)
  if (item.supersedes) {
    run(
      ctx,
      "UPDATE memories SET state='superseded' WHERE id=? AND state='active'",
      item.supersedes,
    )
    run(ctx, 'DELETE FROM vectors WHERE memory_id=?', item.supersedes)
    run(ctx, 'DELETE FROM memory_fts WHERE id=?', item.supersedes)
  }
}
function insertCitations(
  ctx: Context,
  id: string,
  citations: Extraction['memories'][number]['citations'],
  excerpts: Extraction['evidence'],
  evidence: Map<number, string>,
): void {
  for (const citation of citations) {
    let evidenceId = evidence.get(citation.evidence)
    if (!evidenceId) {
      const excerpt = excerpts[citation.evidence]
      if (!excerpt) throw new Error('Brain citation evidence not found.')
      evidenceId = ctx.id()
      run(
        ctx,
        'INSERT INTO evidence VALUES (?,?,?,?,?,?)',
        evidenceId,
        excerpt.entryId,
        excerpt.role,
        excerpt.label,
        excerpt.observedAt,
        excerpt.text,
      )
      evidence.set(citation.evidence, evidenceId)
    }
    run(ctx, 'INSERT INTO citations VALUES (?,?,?)', id, evidenceId, citation.quote)
  }
}
function applyConfirmations(ctx: Context, extraction: Extraction): void {
  for (const confirmation of extraction.confirmations ?? []) {
    if (!one(ctx, "SELECT id FROM memories WHERE id=? AND state='active'", confirmation.memoryId))
      continue
    insertCitations(
      ctx,
      confirmation.memoryId,
      confirmation.citations,
      confirmation.evidence,
      new Map(),
    )
  }
}
