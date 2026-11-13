import type { BrainMemory, BrainMemoryDetail, BrainQuote } from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { referencedEntities } from './entities'
import type { EvidenceExcerpt } from './types'

export function memoryNumber(ctx: Context, id: string): number {
  const found = one<{ n: number }>(ctx, 'SELECT n FROM memories WHERE id=?', id)
  if (!found) throw new Error('Brain memory not found.')
  return found.n
}
export function memoryCard(ctx: Context, id: string): BrainMemory {
  const row = one<
    Omit<BrainMemory, 'origin' | 'entityIds' | 'links'> & {
      n: number
      originSession: string | null
      originTitle: string | null
    }
  >(
    ctx,
    `SELECT n,id,job_id AS jobId,summary,type,epistemic AS kind,state,scope,branch,valid_from AS validFrom,valid_to AS validTo,observed_at AS observedAt,recorded_at AS recordedAt,origin_session AS originSession,origin_title AS originTitle FROM memories WHERE id=?`,
    id,
  )
  if (!row) throw new Error('Brain memory not found.')
  const { n, originSession, originTitle, ...value } = row
  return {
    ...value,
    origin: originSession ? { sessionId: originSession, title: originTitle ?? '' } : null,
    entityIds: all<{ id: string }>(
      ctx,
      'SELECT e.id FROM mentions a JOIN entities e ON e.n=a.entity WHERE a.memory=?',
      n,
    ).map((item) => item.id),
    links: all(
      ctx,
      `SELECT CAST(r.n AS TEXT) AS id,s.id AS subjectId,r.predicate,o.id AS objectId,? AS memoryId FROM relations r JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object WHERE r.memory=?`,
      id,
      n,
    ),
  }
}
export function memoryCards(ctx: Context, ids: string[]): BrainMemory[] {
  return [...new Set(ids)].map((id) => memoryCard(ctx, id))
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
function quotes(ctx: Context, sql: string, n: number): BrainQuote[] {
  return all<{ quote: string; text: string; label: string }>(ctx, sql, n).map((row) =>
    quoteContext(row.quote, row),
  )
}
export function memory(ctx: Context, id: string): BrainMemoryDetail {
  const card = memoryCard(ctx, id)
  const n = memoryNumber(ctx, id)
  const related = all<{ id: string; kind: 'supersedes' | 'conflicts' | 'resolves' }>(
    ctx,
    `SELECT m.id,l.kind FROM memory_links l JOIN memories m ON m.n=l.target WHERE l.source=? UNION ALL SELECT m.id,l.kind FROM memory_links l JOIN memories m ON m.n=l.source WHERE l.target=? LIMIT 100`,
    n,
    n,
  ).map((row) => ({ kind: row.kind, memory: memoryCard(ctx, row.id) }))
  const history = all<{ id: string }>(
    ctx,
    `WITH RECURSIVE chain(n) AS (SELECT ? UNION SELECT CASE WHEN l.source=c.n THEN l.target ELSE l.source END FROM chain c JOIN memory_links l ON (l.source=c.n OR l.target=c.n) AND l.kind='supersedes' LIMIT 100) SELECT m.id FROM chain c JOIN memories m ON m.n=c.n WHERE m.n!=? ORDER BY m.recorded_at DESC`,
    n,
    n,
  ).map((row) => memoryCard(ctx, row.id))
  const source = card.origin
    ? one<{ session_path: string }>(
        ctx,
        'SELECT session_path FROM jobs WHERE session_id=? ORDER BY queued_at DESC,rowid DESC LIMIT 1',
        card.origin.sessionId,
      )
    : undefined
  return {
    memory: card,
    quotes: quotes(
      ctx,
      'SELECT c.quote,e.text,e.label FROM citations c JOIN evidence e ON e.n=c.evidence WHERE c.memory=?',
      n,
    ),
    linkQuotes: Object.fromEntries(
      card.links.map((link) => [
        link.id,
        quotes(
          ctx,
          'SELECT s.quote,e.text,e.label FROM relation_support s JOIN evidence e ON e.n=s.evidence WHERE s.relation=?',
          Number(link.id),
        ),
      ]),
    ),
    entities: referencedEntities(ctx, [card]),
    history,
    related,
    sourcePath: source?.session_path ?? null,
  }
}
