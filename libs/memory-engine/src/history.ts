import type { BrainJob } from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { job } from './jobs'

/**
 * A memory another lane, Brain Agent or you also stand behind stays whole on Read again: a quote
 * from another lane, or a link stated by Brain Agent or you (their evidence has no lane).
 */
const shared = `(
  EXISTS(SELECT 1 FROM citations c JOIN evidence e ON e.n=c.evidence
    WHERE c.memory=m.n AND e.session_id != m.origin_session) OR
  EXISTS(SELECT 1 FROM relations r JOIN relation_support s ON s.relation=r.n
    JOIN evidence e ON e.n=s.evidence WHERE r.memory=m.n AND e.session_id != m.origin_session) OR
  EXISTS(SELECT 1 FROM relations r WHERE r.memory=m.n AND r.stated_by!='reader')
)`
/** Null provenance never belongs to a lane. */
export function laneMemories(
  ctx: Context,
  sessionId: string,
  exceptJobId?: string,
): {
  ids: string[]
  replaceable: string[]
} {
  const rows = all<{ id: string; shared: number }>(
    ctx,
    `
    SELECT m.id, ${shared} AS shared FROM memories m
    WHERE m.origin_session=? AND (? IS NULL OR m.job_id IS NOT ?)`,
    sessionId,
    exceptJobId ?? null,
    exceptJobId ?? null,
  )
  return { ids: rows.map((r) => r.id), replaceable: rows.filter((r) => !r.shared).map((r) => r.id) }
}
/** The lane's newest finished read, its current memories, and what Read again would replace. */
export function laneRead(
  ctx: Context,
  sessionId: string,
): { job: BrainJob; memories: number; replaceable: number } | null {
  const row = one<{ id: string }>(
    ctx,
    `SELECT id FROM jobs WHERE session_id=? AND state IN ('done','empty','rejected')
    ORDER BY queued_at DESC, rowid DESC LIMIT 1`,
    sessionId,
  )
  if (!row) return null
  const memories = one<{ n: number }>(
    ctx,
    "SELECT COUNT(*) AS n FROM memories WHERE job_id=? AND state IN ('active','disputed')",
    row.id,
  )!.n
  return {
    job: job(ctx, row.id)!,
    memories,
    replaceable: laneMemories(ctx, sessionId).replaceable.length,
  }
}
/** Bounded context for incremental extraction; reconciliation still searches all of Brain. */
export function laneContext(ctx: Context, sessionId: string): string[] {
  return all<{ summary: string }>(
    ctx,
    `SELECT summary FROM memories WHERE origin_session=? AND state IN ('active','disputed')
     ORDER BY recorded_at DESC, n DESC LIMIT 60`,
    sessionId,
  ).map((row) => row.summary)
}
