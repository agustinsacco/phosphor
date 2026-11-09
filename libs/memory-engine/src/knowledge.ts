import type {
  BrainMemory,
  BrainMemoryDetail,
  BrainQuote,
  BrainKnowledge,
} from '@phosphor/shared/brain'
import { all, one, run, transaction, type Context } from './database'
import { cleanOrphans, entities, referencedEntities } from './entities'
import { bumpRevision } from './prefs'
import type { KnownContext, EvidenceExcerpt } from './types'

const columns = `id, scope, subject_id AS subjectId, predicate, object_id AS objectId, literal,
 summary, type, kind, branch, valid_from AS validFrom, recorded_at AS recordedAt,
 COALESCE((SELECT NULLIF(MAX(e.observed_at), 0) FROM citations c JOIN evidence e
   ON e.id=c.evidence_id WHERE c.memory_id=memories.id), recorded_at) AS observedAt,
 origin_session AS originSession, origin_title AS originTitle`
type MemoryRow = Omit<BrainMemory, 'origin'> & {
  originSession: string | null
  originTitle: string | null
}
function decode(row: MemoryRow): BrainMemory {
  const { originSession, originTitle, ...memory } = row
  return {
    ...memory,
    origin: originSession === null ? null : { sessionId: originSession, title: originTitle ?? '' },
  }
}
export function activeMemories(ctx: Context): BrainMemory[] {
  return all<MemoryRow>(
    ctx,
    `SELECT ${columns} FROM memories WHERE state='active' ORDER BY recorded_at DESC, rowid DESC`,
  ).map(decode)
}
export function memory(ctx: Context, id: string): BrainMemoryDetail {
  const row = one<MemoryRow>(ctx, `SELECT ${columns} FROM memories WHERE id=?`, id)
  if (!row) throw new Error('Brain memory not found.')
  const quotes = all<{ quote: string; text: string; label: string }>(
    ctx,
    `SELECT c.quote, e.text, e.label FROM citations c JOIN evidence e ON e.id=c.evidence_id WHERE c.memory_id=?`,
    id,
  ).map(({ quote, text, label }) => quoteContext(quote, { text, label }))
  return { memory: decode(row), quotes }
}
export function quoteContext(
  quote: string,
  evidence: Pick<EvidenceExcerpt, 'text' | 'label'>,
): BrainQuote {
  const start = evidence.text.indexOf(quote)
  return {
    quote,
    label: evidence.label,
    before: start < 0 ? '' : evidence.text.slice(Math.max(0, start - 160), start),
    after: start < 0 ? '' : evidence.text.slice(start + quote.length, start + quote.length + 160),
  }
}
export function knowledge(ctx: Context, limit = 2000): BrainKnowledge {
  const active = activeMemories(ctx)
  const memories = active.slice(0, Math.max(0, limit))
  return {
    memories,
    entities: referencedEntities(ctx, memories),
    truncated: active.length > memories.length,
  }
}
export function forget(ctx: Context, id: string): void {
  transaction(ctx, () => {
    run(ctx, 'DELETE FROM memory_fts WHERE id=?', id)
    run(ctx, 'DELETE FROM memories WHERE id=?', id)
    cleanOrphans(ctx)
    bumpRevision(ctx)
  })
}
export function known(ctx: Context, sessionId: string, scope: string, limit: number): KnownContext {
  const delivered = new Set(
    all<{ memory_id: string }>(
      ctx,
      'SELECT memory_id FROM deliveries WHERE session_id=?',
      sessionId,
    ).map((row) => row.memory_id),
  )
  const memories = activeMemories(ctx)
    .filter(
      (item) =>
        delivered.has(item.id) || item.origin?.sessionId === sessionId || item.scope === scope,
    )
    .slice(0, Math.max(0, limit))
  const referenced = referencedEntities(ctx, memories)
  const ids = new Set(referenced.map((item) => item.id))
  return {
    memories,
    entities: [
      ...referenced,
      ...entities(ctx)
        .filter((item) => !ids.has(item.id))
        .slice(0, 60),
    ],
  }
}
export function recordDelivery(ctx: Context, sessionId: string, ids: string[]): void {
  transaction(ctx, () => {
    for (const id of new Set(ids)) {
      run(
        ctx,
        `INSERT OR REPLACE INTO deliveries SELECT ?, id, ? FROM memories WHERE id=? AND state='active'`,
        sessionId,
        ctx.now(),
        id,
      )
    }
  })
}
