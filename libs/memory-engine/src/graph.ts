import {
  BRAIN_PREDICATES,
  type BrainGraph,
  type BrainLink,
  type BrainPaths,
} from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { entity, survivingEntityId, referencedEntities } from './entities'
import { memoryCards } from './knowledge'
import { newerLink, sideIndex } from './relation-pairs'

const LINK = `CAST(r.n AS TEXT) AS id,s.id AS subjectId,r.predicate,o.id AS objectId,m.id AS memoryId`
const ENDS =
  'JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory'
/**
 * Per predicate and direction, the newest link to each of at most `perPredicate` neighbours,
 * newest first: one slot per neighbour, so a pair said many times never hides another.
 */
export function edges(ctx: Context, id: string, perPredicate = 8): BrainLink[] {
  id = survivingEntityId(ctx, id)
  const row = one<{ n: number; connections: number }>(
    ctx,
    'SELECT n,connections FROM entities WHERE id=?',
    id,
  )
  if (!row) throw new Error('Brain entity not found.')
  const { n, connections } = row
  if (connections <= 200) return ordinaryEdges(ctx, n, perPredicate)
  // A hub reads each range newest first and skips a link when a newer one joins the same pair.
  return BRAIN_PREDICATES.flatMap((predicate) =>
    (['subject', 'object'] as const).flatMap((own) => {
      const other = own === 'subject' ? 'object' : 'subject'
      return all<BrainLink>(
        ctx,
        `SELECT ${LINK} FROM relations r INDEXED BY ${sideIndex(own)} JOIN entities e ON e.n=r.${other} ${ENDS} WHERE r.${own}=? AND r.live=1 AND r.predicate=? AND ${newerLink(own, other)} IS NULL ORDER BY r.observed_at DESC,r.n DESC LIMIT ?`,
        n,
        predicate,
        connections,
        perPredicate,
      )
    }),
  )
}
/** Low-degree nodes need two indexed reads, not one for every predicate and direction. */
function ordinaryEdges(ctx: Context, n: number, perPredicate: number): BrainLink[] {
  const directions = (['subject', 'object'] as const).map((own) => {
    const groups = new Map<string, Map<string, BrainLink>>()
    for (const link of all<BrainLink>(
      ctx,
      `SELECT ${LINK} FROM relations r ${ENDS} WHERE r.${own}=? AND r.live=1 ORDER BY r.observed_at DESC,r.n DESC`,
      n,
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
  return graph(ctx, [...selected], id, truncated)
}
/** Layered bidirectional BFS, bounded before expansion; every route is backed by live evidence. */
export function path(ctx: Context, from: string, to: string): BrainPaths {
  from = survivingEntityId(ctx, from)
  to = survivingEntityId(ctx, to)
  type Route = { node: string; links: BrainLink[]; visited: Set<string> }
  let left: Route[] = [{ node: from, links: [], visited: new Set([from]) }]
  let right: Route[] = [{ node: to, links: [], visited: new Set([to]) }]
  let budget = 2000
  let found: BrainLink[][] = []
  for (let depth = 0; depth <= 4 && budget > 0; depth++) {
    const targets = new Map<string, Route[]>()
    for (const route of right) targets.set(route.node, [...(targets.get(route.node) ?? []), route])
    for (const route of left)
      for (const other of targets.get(route.node) ?? []) {
        if (route.node !== from && route.node !== to && entity(ctx, route.node)!.connections > 200)
          continue
        const common = [...route.visited].filter((id) => other.visited.has(id))
        if (common.length === 1) found.push([...route.links, ...other.links.toReversed()])
      }
    if (found.length) break
    const expandLeft = depth % 2 === 0
    const next: Route[] = []
    for (const route of expandLeft ? left : right) {
      if (--budget < 0) break
      if (route.node !== from && route.node !== to && entity(ctx, route.node)!.connections > 200)
        continue
      for (const link of edges(ctx, route.node)) {
        const node = route.node === link.subjectId ? link.objectId : link.subjectId
        if (route.visited.has(node) || next.length >= 2000) continue
        next.push({
          node,
          links: [...route.links, link],
          visited: new Set([...route.visited, node]),
        })
      }
    }
    if (expandLeft) left = next
    else right = next
  }
  found = found.slice(0, 3)
  const memories = memoryCards(ctx, [...new Set(found.flat().map((link) => link.memoryId))])
  return { paths: found, memories, entities: referencedEntities(ctx, memories) }
}
