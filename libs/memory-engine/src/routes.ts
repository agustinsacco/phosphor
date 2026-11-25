import type { BrainRoutes, BrainRouteStep } from '@phosphor/shared/brain-recall'
import { all, type Context } from './database'
import { entity, referencedEntities } from './entities'
import { edges } from './graph'
import { memoryCards } from './knowledge'

type Step = BrainRouteStep
type Route = { node: string; path: Step[]; visited: Set<string> }
const other = (id: string, step: Step) =>
  step.kind === 'relation'
    ? step.link.subjectId === id
      ? step.link.objectId
      : step.link.subjectId
    : step.toId
const reverse = (step: Step): Step =>
  step.kind === 'relation' ? step : { ...step, fromId: step.toId, toId: step.fromId }
class Navigation {
  private windows = new Map<string, Map<number, string>>()
  private neighbours = new Map<string, Step[]>()
  private hubs = new Map<string, boolean>()
  constructor(
    private ctx: Context,
    private now: number,
  ) {}
  hub(id: string) {
    if (!this.hubs.has(id)) {
      const e = entity(this.ctx, id)!
      this.hubs.set(id, e.connections > 200 || e.memories > 2000)
    }
    return this.hubs.get(id)!
  }
  private recent(id: string) {
    let result = this.windows.get(id)
    if (!result) {
      const rows = all<{ n: number; id: string }>(
        this.ctx,
        `SELECT m.n,m.id FROM mentions a CROSS JOIN memories m ON m.n=a.memory WHERE a.entity=(SELECT n FROM entities WHERE id=?) AND m.state!='superseded' AND (m.valid_to IS NULL OR m.valid_to>?) ORDER BY a.memory DESC LIMIT 64`,
        id,
        this.now,
      )
      result = new Map(rows.map((r) => [r.n, r.id]))
      this.windows.set(id, result)
    }
    return result
  }
  steps(id: string) {
    const cached = this.neighbours.get(id)
    if (cached) return cached
    const steps: Step[] = edges(this.ctx, id, 8, this.now).map((link) => ({
      kind: 'relation',
      link,
    }))
    const linked = new Set(steps.map((s) => other(id, s)))
    const recent = this.recent(id)
    const counts = new Map<string, { memoryId: string; shared: number }>()
    for (const row of all<{ id: string; memory: number }>(
      this.ctx,
      `SELECT e.id,a.memory FROM json_each(?) j CROSS JOIN mentions a ON a.memory=j.value CROSS JOIN entities e ON e.n=a.entity WHERE e.id!=? ORDER BY a.memory DESC`,
      JSON.stringify([...recent.keys()]),
      id,
    )) {
      if (linked.has(row.id) || !this.recent(row.id).has(row.memory)) continue
      const entry = counts.get(row.id) ?? { memoryId: recent.get(row.memory)!, shared: 0 }
      entry.shared++
      counts.set(row.id, entry)
    }
    for (const [toId, support] of counts)
      steps.push({ kind: 'together', fromId: id, toId, ...support })
    this.neighbours.set(id, steps)
    return steps
  }
}
function meet(left: Route[], right: Route[], hub: (id: string) => boolean) {
  const found: Step[][] = []
  const targets = new Map<string, Route[]>()
  for (const r of right) {
    const list = targets.get(r.node) ?? []
    list.push(r)
    targets.set(r.node, list)
  }
  for (const r of left) {
    if (hub(r.node)) continue
    for (const other of targets.get(r.node) ?? []) {
      if ([...r.visited].some((id) => id !== r.node && other.visited.has(id))) continue
      found.push([...r.path, ...other.path.toReversed().map(reverse)])
      if (found.length === 3) return found
    }
  }
  return found
}
function shortest(graph: Navigation, from: string, to: string) {
  const start = (node: string): Route[] => [{ node, path: [], visited: new Set([node]) }]
  let left = start(from),
    right = start(to),
    budget = 2000
  const hub = (id: string) => id !== from && id !== to && graph.hub(id)
  for (let depth = 0; depth <= 4; depth++) {
    const found = meet(left, right, hub)
    if (found.length || depth === 4) return found
    const next: Route[] = []
    for (const r of depth % 2 ? right : left) {
      if (--budget < 0) break
      if (hub(r.node)) continue
      for (const step of graph.steps(r.node)) {
        const node = other(r.node, step)
        if (r.visited.has(node) || hub(node)) continue
        next.push({ node, path: [...r.path, step], visited: new Set([...r.visited, node]) })
        if (next.length >= 2000) break
      }
      if (next.length >= 2000) break
    }
    if (depth % 2) right = next
    else left = next
    if (!next.length) break
  }
  return []
}
export function routes(ctx: Context, fromId: string, toId: string, now: number): BrainRoutes {
  const from = entity(ctx, fromId) ?? null,
    to = entity(ctx, toId) ?? null
  const paths =
    from && to && from.id !== to.id ? shortest(new Navigation(ctx, now), fromId, toId) : []
  const ids = paths
    .flat()
    .flatMap((s) =>
      s.kind === 'relation' ? [s.link.subjectId, s.link.objectId] : [s.fromId, s.toId],
    )
  const memories = memoryCards(
    ctx,
    paths.flat().map((s) => (s.kind === 'relation' ? s.link.memoryId : s.memoryId)),
  )
  return {
    mode: 'route',
    status: paths.length ? 'ok' : 'no_match',
    from,
    to,
    routes: paths,
    memories,
    entities: referencedEntities(ctx, [...memories, { entityIds: ids }]),
  }
}
