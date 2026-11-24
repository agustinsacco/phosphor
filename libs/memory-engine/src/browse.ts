import type { BrainEntityKind, BrainEntityPage } from '@phosphor/shared/brain'
import type { BrainEntitySort } from '@phosphor/shared/brain-explore'
import { all, one, type Context } from './database'
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

const BATCH = 256
/**
 * A filtered set whose entities hold at most this many current memories is ordered from their own
 * mentions; reading newest memories first could otherwise walk a million rows to find one old
 * entity of a rare kind.
 */
export const DIRECT_MEMORIES = 20_000
interface Row {
  n: number
  at: number
}
/** One current state's memories, newest first and then by row, read in bounded index batches. */
function* newestOf(ctx: Context, state: 'active' | 'disputed'): Generator<Row> {
  let at = Number.MAX_SAFE_INTEGER
  let n = Number.MAX_SAFE_INTEGER
  for (;;) {
    // The rest of the current timestamp, then older ones: both follow memories_recent's order.
    const rows = [
      ...all<Row>(
        ctx,
        'SELECT n,observed_at AS at FROM memories WHERE state=? AND observed_at=? AND n>? ORDER BY n LIMIT ?',
        state,
        at,
        n,
        BATCH,
      ),
    ]
    if (rows.length < BATCH)
      rows.push(
        ...all<Row>(
          ctx,
          'SELECT n,observed_at AS at FROM memories WHERE state=? AND observed_at<? ORDER BY observed_at DESC,n LIMIT ?',
          state,
          at,
          BATCH - rows.length,
        ),
      )
    if (!rows.length) return
    yield* rows
    ;({ at, n } = rows.at(-1)!)
  }
}
/** Every current memory as (observed_at DESC, n ASC), merging the two current states. */
function* newestMemories(ctx: Context): Generator<Row> {
  const streams = [newestOf(ctx, 'active'), newestOf(ctx, 'disputed')]
  const heads = streams.map((stream) => stream.next())
  for (;;) {
    let pick = -1
    heads.forEach((head, i) => {
      if (head.done) return
      const best = pick < 0 ? null : (heads[pick]!.value as Row)
      if (!best || head.value.at > best.at || (head.value.at === best.at && head.value.n < best.n))
        pick = i
    })
    if (pick < 0) return
    yield heads[pick]!.value as Row
    heads[pick] = streams[pick]!.next()
  }
}
/**
 * The listed entities (`memories>0`, optionally one kind) ordered by their newest current memory,
 * newest first, ties and entities with none by row: the first `need` of them. `listed` is their
 * count and their stored memory counts' sum. A large set reads current memories newest first and
 * stops once it has them, so a first page reads a few dozen rows, and a page at offset 2,000 a
 * few thousand; a small one reads its own entities' mentions.
 */
export function recentEntities(
  ctx: Context,
  kind: BrainEntityKind | null,
  need: number,
  listed: { total: number; memories: number },
): number[] {
  if (kind && listed.memories <= DIRECT_MEMORIES)
    return all<{ n: number }>(
      ctx,
      `SELECT n FROM entities e WHERE memories>0 AND kind=? ORDER BY (SELECT MAX(m.observed_at)
        FROM mentions a CROSS JOIN memories m ON m.n=a.memory
        WHERE a.entity=e.n AND m.state IN ('active','disputed')) DESC NULLS LAST,n LIMIT ?`,
      kind,
      need,
    ).map((row) => row.n)
  return newestFirst(ctx, kind, need, listed.total)
}
function newestFirst(
  ctx: Context,
  kind: BrainEntityKind | null,
  need: number,
  total: number,
): number[] {
  const ordered: number[] = []
  const seen = new Set<number>()
  let block: number[] = []
  let blockAt: number | null = null
  const flush = (): void => {
    for (const n of block.sort((a, b) => a - b)) ordered.push(n)
    block = []
  }
  const target = Math.min(need, total)
  for (const memory of newestMemories(ctx)) {
    if (memory.at !== blockAt) {
      flush()
      if (ordered.length >= target) break
      blockAt = memory.at
    }
    for (const { entity } of all<{ entity: number }>(
      ctx,
      `SELECT a.entity FROM mentions a JOIN entities e ON e.n=a.entity WHERE a.memory=? AND e.memories>0 ${kind ? 'AND e.kind=?' : ''}`,
      memory.n,
      ...(kind ? [kind] : []),
    ))
      if (!seen.has(entity)) {
        seen.add(entity)
        block.push(entity)
      }
  }
  flush()
  // Only a stored count that still lists an entity with no current memory reaches this.
  if (ordered.length < target)
    ordered.push(
      ...all<{ n: number }>(
        ctx,
        `SELECT n FROM entities WHERE memories>0 ${kind ? 'AND kind=?' : ''} AND n NOT IN (SELECT value FROM json_each(?)) ORDER BY n LIMIT ?`,
        ...(kind ? [kind] : []),
        JSON.stringify(ordered),
        need - ordered.length,
      ).map((row) => row.n),
    )
  return ordered.slice(0, need)
}
