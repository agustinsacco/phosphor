import type { BrainEntityKind, BrainEntityPage, BrainRecentMemories } from '@phosphor/shared/brain'
import type { BrainEntitySort } from '@phosphor/shared/brain-explore'
import { all, one, type Context } from './database'
import { recentEntities } from './browse-recent'
import { entity } from './entities'

const ORDER: Record<Exclude<BrainEntitySort, 'recent'>, string> = {
  connected: 'connections DESC,n ASC',
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
  const counts = all<{ kind: BrainEntityKind; total: number; memories: number }>(
    ctx,
    'SELECT kind,COUNT(*) AS total,SUM(memories) AS memories FROM entities WHERE memories>0 GROUP BY kind',
  )
  const listed = counts.filter((row) => !kind || row.kind === kind)
  const total = listed.reduce((sum, row) => sum + row.total, 0)
  const memories = listed.reduce((sum, row) => sum + row.memories, 0)
  const rows =
    sort === 'recent'
      ? recentEntities(ctx, kind, offset + limit + 1, { total, memories })
          .slice(offset)
          .map((n) => one<{ id: string }>(ctx, 'SELECT id FROM entities WHERE n=?', n)!)
      : all<{ id: string }>(
          ctx,
          `SELECT id FROM entities WHERE memories>0 ${kind ? 'AND kind=?' : ''} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`,
          ...(kind ? [kind] : []),
          limit + 1,
          offset,
        )
  return {
    items: rows.slice(0, limit).map(({ id }) => {
      const value = entity(ctx, id)!
      return { entity: value, memories: value.memories }
    }),
    more: rows.length > limit,
    kinds: counts.map((row) => row.kind),
    counts: Object.fromEntries(counts.map((row) => [row.kind, row.total])),
    total,
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
