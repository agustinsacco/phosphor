import type { BrainEntityKind, BrainEntityPage, BrainRecentMemories } from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { entity } from './entities'

/** v5's connection index supplies the browse order; counts include historical memories. */
export function entities(
  ctx: Context,
  kind: BrainEntityKind | null,
  offset: number,
  limit: number,
): BrainEntityPage {
  const rows = all<{ id: string }>(
    ctx,
    `SELECT id FROM entities WHERE memories>0 ${kind ? 'AND kind=?' : ''} ORDER BY connections DESC,n ASC LIMIT ? OFFSET ?`,
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
    kinds: all<{ kind: BrainEntityKind }>(
      ctx,
      'SELECT DISTINCT kind FROM entities WHERE memories>0',
    ).map((row) => row.kind),
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
