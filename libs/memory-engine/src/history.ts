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
  const counts = page.length
    ? all<{ sessionId: string; jobId: string | null; memories: number; replaceable: number }>(
        ctx,
        `SELECT m.origin_session AS sessionId, m.job_id AS jobId,
        SUM(m.state IN ('active','disputed')) AS memories,
        SUM(NOT ${independentlySupported}) AS replaceable FROM memories m
        WHERE m.origin_session IN (${page.map(() => '?').join(',')}) GROUP BY m.origin_session, m.job_id`,
        ...page.map((j) => j.sessionId),
      )
    : []
  const byRead = new Map(counts.map((row) => [row.jobId, row.memories]))
  const replaceable = new Map<string, number>()
  for (const row of counts)
    replaceable.set(row.sessionId, (replaceable.get(row.sessionId) ?? 0) + row.replaceable)
  return {
    items: page.map((job) => ({
      job,
      memories: byRead.get(job.id) ?? 0,
      replaceable: replaceable.get(job.sessionId) ?? 0,
    })),
    more: rows.length > limit,
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
