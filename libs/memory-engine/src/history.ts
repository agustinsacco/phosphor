import type { BrainHistory } from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { finishedJobs } from './jobs'

const independentlySupported = `(
  EXISTS(SELECT 1 FROM citations c JOIN evidence e ON e.n=c.evidence
    WHERE c.memory=m.n AND e.session_id != m.origin_session) OR
  EXISTS(SELECT 1 FROM relations r JOIN relation_support s ON s.relation=r.n
    JOIN evidence e ON e.n=s.evidence WHERE r.memory=m.n AND e.session_id != m.origin_session)
)`
/** Null provenance never belongs to a lane. Independent support protects the entire memory. */
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
    SELECT m.id, ${independentlySupported} AS shared FROM memories m
    WHERE m.origin_session=? AND (? IS NULL OR m.job_id IS NOT ?)`,
    sessionId,
    exceptJobId ?? null,
    exceptJobId ?? null,
  )
  return { ids: rows.map((r) => r.id), replaceable: rows.filter((r) => !r.shared).map((r) => r.id) }
}
export function history(ctx: Context, limit: number): BrainHistory {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Invalid Brain history limit.')
  const rows = finishedJobs(ctx, limit + 1)
  const page = rows.slice(0, limit)
  const counts = new Map(
    page.length
      ? all<{ sessionId: string; memories: number; replaceable: number }>(
          ctx,
          `SELECT m.origin_session AS sessionId, COUNT(*) AS memories,
      SUM(NOT ${independentlySupported}) AS replaceable FROM memories m
      WHERE m.origin_session IN (${page.map(() => '?').join(',')}) GROUP BY m.origin_session`,
          ...page.map((j) => j.sessionId),
        ).map((row) => [row.sessionId, row])
      : [],
  )
  return {
    items: page.map((job) => ({
      job,
      memories: counts.get(job.sessionId)?.memories ?? 0,
      replaceable: counts.get(job.sessionId)?.replaceable ?? 0,
    })),
    more: rows.length > limit,
  }
}
