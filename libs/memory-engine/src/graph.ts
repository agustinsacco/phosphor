import { BRAIN_PREDICATES, type BrainGraph, type BrainLink } from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { entity, survivingEntityId } from './entities'
import { LINK, ENDS, endedLinks } from './relation-reads'
import { newerLink, sideIndex } from './relation-pairs'

/**
 * Per predicate and direction, the newest link to each of at most `perPredicate` neighbours,
 * newest first: one slot per neighbour, so a pair said many times never hides another.
 */
export function edges(ctx: Context, id: string, perPredicate = 8, now = ctx.now()): BrainLink[] {
  id = survivingEntityId(ctx, id)
  const row = one<{ n: number; connections: number }>(
    ctx,
    'SELECT n,connections FROM entities WHERE id=?',
    id,
  )
  if (!row) throw new Error('Brain entity not found.')
  const { n, connections } = row
  if (connections <= 200) return ordinaryEdges(ctx, n, perPredicate, now)
  // A hub reads each range newest first and skips a link when a newer one joins the same pair.
  return BRAIN_PREDICATES.flatMap((predicate) =>
    (['subject', 'object'] as const).flatMap((own) => {
      const other = own === 'subject' ? 'object' : 'subject'
      return all<BrainLink>(
        ctx,
        `SELECT ${LINK} FROM relations r INDEXED BY ${sideIndex(own)} JOIN entities e ON e.n=r.${other} ${ENDS} WHERE r.${own}=? AND r.live=1 AND (r.valid_to IS NULL OR r.valid_to>?) AND r.predicate=? AND ${newerLink(own, other)} IS NULL ORDER BY r.observed_at DESC,r.n DESC LIMIT ?`,
        n,
        now,
        predicate,
        connections,
        now,
        now,
        perPredicate,
      )
    }),
  )
}
/** Low-degree nodes need two indexed reads, not one for every predicate and direction. */
function ordinaryEdges(ctx: Context, n: number, perPredicate: number, now: number): BrainLink[] {
  const directions = (['subject', 'object'] as const).map((own) => {
    const other = own === 'subject' ? 'object' : 'subject'
    const groups = new Map<string, Map<string, BrainLink>>()
    for (const link of all<BrainLink>(
      ctx,
      `WITH candidates AS (SELECT r.n,ROW_NUMBER() OVER (PARTITION BY r.predicate,r.${other}
        ORDER BY r.observed_at DESC,r.n DESC) AS seq FROM relations r WHERE r.${own}=? AND r.live=1 AND (r.valid_to IS NULL OR r.valid_to>?))
        SELECT ${LINK} FROM candidates c CROSS JOIN relations r ON r.n=c.n ${ENDS} WHERE c.seq=1
        ORDER BY r.observed_at DESC,r.n DESC`,
      n,
      now,
    )) {
      // Newest first, so the first link to a neighbour is its newest.
      const neighbours = groups.get(link.predicate) ?? new Map<string, BrainLink>()
      const neighbour = own === 'subject' ? link.objectId : link.subjectId
      if (neighbours.size < perPredicate && !neighbours.has(neighbour))
        neighbours.set(neighbour, link)
      groups.set(link.predicate, neighbours)
    }
    return groups
  })
  return BRAIN_PREDICATES.flatMap((predicate) =>
    directions.flatMap((groups) => [...(groups.get(predicate)?.values() ?? [])]),
  )
}
/**
 * Links one graph payload carries with its at most 300 nodes. Each is one pair and predicate (its
 * newest link), read from at most eight neighbours per predicate and direction per node, centre
 * first.
 */
export const GRAPH_LINKS = 1500
export function graph(
  ctx: Context,
  ids: string[],
  centerId: string | null,
  truncated: boolean,
): BrainGraph {
  const selected = new Set(ids)
  const links = new Map<string, BrainLink>()
  let cut = false
  for (const id of ids) {
    for (const link of edges(ctx, id)) {
      if (!selected.has(link.subjectId) || !selected.has(link.objectId)) continue
      const pair = `${link.subjectId}\n${link.predicate}\n${link.objectId}`
      if (links.has(pair)) continue
      if (links.size >= GRAPH_LINKS) {
        cut = true
        break
      }
      links.set(pair, link)
    }
    if (cut) break
  }
  return {
    nodes: ids.map((id) => entity(ctx, id)!).filter(Boolean),
    links: [...links.values()],
    ended: centerId
      ? endedLinks(ctx, centerId, ctx.now()).filter(
          (l) => selected.has(l.subjectId) && selected.has(l.objectId),
        )
      : [],
    centerId,
    truncated: truncated || cut,
  }
}
export function overview(ctx: Context, limit: number): BrainGraph {
  const cap = Math.max(0, Math.min(300, limit))
  const rows = all<{ id: string }>(
    ctx,
    'SELECT id FROM entities ORDER BY connections DESC LIMIT ?',
    cap + 1,
  )
  return graph(
    ctx,
    rows.slice(0, cap).map((row) => row.id),
    null,
    rows.length > cap,
  )
}
export function neighbourhood(ctx: Context, id: string, hops: 1 | 2, limit: number): BrainGraph {
  id = survivingEntityId(ctx, id)
  const cap = Math.max(1, Math.min(300, limit))
  const selected = new Set([id])
  let frontier = [id]
  let truncated = false
  for (let depth = 0; depth < hops; depth++) {
    const next: string[] = []
    for (const current of frontier) {
      if (current !== id && entity(ctx, current)!.connections > 200) continue
      for (const link of edges(ctx, current, 300)) {
        const other = current === link.subjectId ? link.objectId : link.subjectId
        if (selected.has(other)) continue
        if (selected.size >= cap) {
          truncated = true
          continue
        }
        selected.add(other)
        next.push(other)
      }
    }
    frontier = next
  }
  for (const link of endedLinks(ctx, id, ctx.now())) {
    const other = link.subjectId === id ? link.objectId : link.subjectId
    if (selected.size < cap) selected.add(other)
    else if (!selected.has(other)) truncated = true
  }
  return graph(ctx, [...selected], id, truncated)
}
