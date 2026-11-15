import {
  BRAIN_PREDICATES,
  type BrainGraph,
  type BrainLink,
  type BrainPaths,
} from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { entity, entityNumber, referencedEntities } from './entities'
import { memoryCards } from './knowledge'

export function edges(ctx: Context, id: string, perPredicate = 8): BrainLink[] {
  const row = one<{ n: number; connections: number }>(
    ctx,
    'SELECT n,connections FROM entities WHERE id=?',
    id,
  )
  if (!row) throw new Error('Brain entity not found.')
  const { n, connections } = row
  if (connections <= 200) return ordinaryEdges(ctx, n, perPredicate)
  return BRAIN_PREDICATES.flatMap((predicate) =>
    (['subject', 'object'] as const).flatMap((column) =>
      all<BrainLink>(
        ctx,
        `SELECT CAST(r.n AS TEXT) AS id,s.id AS subjectId,r.predicate,o.id AS objectId,m.id AS memoryId FROM relations r JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory WHERE r.${column}=? AND r.live=1 AND r.predicate=? ORDER BY r.observed_at DESC,r.n DESC LIMIT ?`,
        n,
        predicate,
        perPredicate,
      ),
    ),
  )
}
/** Low-degree nodes need two indexed reads, not one for every predicate and direction. */
function ordinaryEdges(ctx: Context, n: number, perPredicate: number): BrainLink[] {
  const directions = (['subject', 'object'] as const).map((column) => {
    const groups = new Map<string, BrainLink[]>()
    for (const link of all<BrainLink>(
      ctx,
      `SELECT CAST(r.n AS TEXT) AS id,s.id AS subjectId,r.predicate,o.id AS objectId,m.id AS memoryId FROM relations r JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory WHERE r.${column}=? AND r.live=1 ORDER BY r.observed_at DESC,r.n DESC`,
      n,
    )) {
      const group = groups.get(link.predicate) ?? []
      if (group.length < perPredicate) group.push(link)
      groups.set(link.predicate, group)
    }
    return groups
  })
  return BRAIN_PREDICATES.flatMap((predicate) =>
    directions.flatMap((groups) => groups.get(predicate) ?? []),
  )
}
export function graph(
  ctx: Context,
  ids: string[],
  centerId: string | null,
  truncated: boolean,
): BrainGraph {
  const selected = new Set(ids)
  const links = new Map<string, BrainLink>()
  for (const id of ids)
    for (const link of edges(ctx, id))
      if (selected.has(link.subjectId) && selected.has(link.objectId)) links.set(link.id, link)
  return {
    nodes: ids.map((id) => entity(ctx, id)!).filter(Boolean),
    links: [...links.values()],
    centerId,
    truncated,
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
  entityNumber(ctx, id)
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
  entityNumber(ctx, from)
  entityNumber(ctx, to)
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
