import type { BrainEntityKind, BrainEntityPage, BrainRecentMemories } from '@phosphor/shared/brain'
import type { BrainEntitySort } from '@phosphor/shared/brain-explore'
import { all, type Context } from './database'
import { entity } from './entities'

const ORDER: Record<BrainEntitySort, string> = {
  connected: 'connections DESC,n ASC',
  recent: `(SELECT MAX(m.observed_at) FROM mentions a JOIN memories m ON m.n=a.memory WHERE a.entity=entities.n AND m.state IN ('active','disputed')) DESC NULLS LAST,n ASC`,
  name: 'label COLLATE NOCASE ASC,id ASC',
}
/** v5's connection index supplies the default browse order. */
export function entities(
  ctx: Context,
  kind: BrainEntityKind | null,
  offset: number,
  limit: number,
  sort: BrainEntitySort,
): BrainEntityPage {
  const rows = all<{ id: string }>(
    ctx,
    `SELECT id FROM entities WHERE memories>0 ${kind ? 'AND kind=?' : ''} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`,
    ...(kind ? [kind] : []),
    limit + 1,
    offset,
  )
  const counts = all<{ kind: BrainEntityKind; total: number }>(
    ctx,
    'SELECT kind,COUNT(*) AS total FROM entities WHERE memories>0 GROUP BY kind',
  )
  return {
    items: rows.slice(0, limit).map(({ id }) => {
      const value = entity(ctx, id)!
      return { entity: value, memories: value.memories }
    }),
    more: rows.length > limit,
    kinds: counts.map((row) => row.kind),
    counts: Object.fromEntries(counts.map((row) => [row.kind, row.total])),
    total: counts.reduce((sum, row) => sum + (!kind || row.kind === kind ? row.total : 0), 0),
  }
}

/** Bounded to the latest 20 finished reads; v5 has no global learned-time index. */
export function recent(ctx: Context, limit: number): BrainRecentMemories {
  const jobs = all<{ id: string }>(
    ctx,
    "SELECT id FROM jobs WHERE state='done' ORDER BY finished_at DESC LIMIT 20",
  )
  const items: BrainRecentMemories['items'] = []
  for (const job of jobs) {
    items.push(
      ...all<BrainRecentMemories['items'][number]>(
        ctx,
        "SELECT id,summary,type,origin_title AS originTitle,recorded_at AS learnedAt FROM memories WHERE job_id=? AND state IN ('active','disputed') ORDER BY recorded_at DESC,n DESC LIMIT ?",
        job.id,
        limit - items.length,
      ),
    )
    if (items.length === limit) break
  }
  return { items }
}
