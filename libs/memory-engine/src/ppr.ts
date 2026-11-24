import { BRAIN_STRUCTURAL_PREDICATES, type BrainLink } from '@phosphor/shared/brain'
import type { BrainTrail } from '@phosphor/shared/brain-recall'
import { all, one, type Context } from './database'
import { edgesAt } from './graph'
import { RECALL_TUNING, type RecallTuning } from './recall-tuning'

const STRUCTURAL = new Set<string>(BRAIN_STRUCTURAL_PREDICATES)
export interface Seeds {
  entities: Map<string, number>
  memories: Map<string, number>
  focus: Set<string>
}
interface EntityNode {
  id: string
  n: number
  memories: number
  connections: number
  index: number
  idf: number
  trail: BrainTrail | null
}
type Adj = Map<number, number>[]
class LocalGraph {
  readonly adj: Adj = []
  readonly personalization: number[] = []
  readonly entities = new Map<string, EntityNode>()
  readonly memories = new Map<string, number>()
  private readonly pending = new Set<string>()
  readonly explanations = new Map<string, BrainTrail>()
  readonly relations = new Set<string>()
  private total: number
  constructor(
    readonly ctx: Context,
    readonly now: number,
    readonly seeds: Seeds,
    readonly tuning: RecallTuning,
  ) {
    this.total = Math.max(
      1,
      Number(
        one<{ value: string }>(ctx, "SELECT value FROM meta WHERE key='memories'")?.value ?? 1,
      ),
    )
  }
  private node(seed: number) {
    this.personalization.push(seed)
    return this.adj.push(new Map()) - 1
  }
  private connect(a: number, b: number, w: number) {
    this.adj[a]!.set(b, w)
    this.adj[b]!.set(a, w)
  }
  private entity(id: string, trail: BrainTrail | null) {
    const existing = this.entities.get(id)
    if (existing) {
      if (trail && (!existing.trail || existing.trail.links.length > trail.links.length))
        existing.trail = trail
      return existing
    }
    if (this.entities.size >= 300) return undefined
    const row = one<Omit<EntityNode, 'trail' | 'index' | 'idf'>>(
      this.ctx,
      'SELECT id,n,memories,connections FROM entities WHERE id=?',
      id,
    )
    if (!row) return undefined
    const idf = Math.log1p(this.total / (1 + row.memories)) / Math.log1p(this.total)
    const node = {
      ...row,
      index: this.node(this.seeds.entities.get(id) ?? 0),
      idf,
      trail,
    }
    this.entities.set(id, node)
    return node
  }
  private memory(id: string) {
    const existing = this.memories.get(id)
    if (existing !== undefined || this.memories.size >= 4000) return existing
    const index = this.node(this.seeds.memories.get(id) ?? 0)
    this.memories.set(id, index)
    return index
  }
  private mention(e: EntityNode, id: string) {
    const index = this.memory(id)
    if (index === undefined) return
    this.connect(e.index, index, e.idf)
  }
  seed() {
    for (const id of this.seeds.entities.keys())
      this.entity(id, { seedId: id, entityId: id, links: [] })
    for (const row of all<{ id: string; entityId: string | null }>(
      this.ctx,
      `SELECT m.id,e.id AS entityId FROM json_each(?) j CROSS JOIN memories m ON m.id=j.value
      LEFT JOIN mentions a ON a.memory=m.n LEFT JOIN entities e ON e.n=a.entity
      WHERE m.state!='superseded' AND (m.valid_to IS NULL OR m.valid_to>?)`,
      JSON.stringify([...this.seeds.memories.keys()]),
      this.now,
    )) {
      this.memory(row.id)
      const e = row.entityId ? this.entity(row.entityId, null) : null
      if (e) this.mention(e, row.id)
    }
  }
  expand(e: EntityNode, depth: number) {
    const focus = this.seeds.focus.has(e.id)
    if (!focus && (e.memories > 2000 || e.connections > 200)) return
    // Insertion number orders the bounded recent window directly in mentions_entity, even for a hub.
    for (const { id } of all<{ id: string }>(
      this.ctx,
      `SELECT m.id FROM mentions a CROSS JOIN memories m ON m.n=a.memory
      WHERE a.entity=? AND m.state!='superseded' AND (m.valid_to IS NULL OR m.valid_to>?) ORDER BY a.memory DESC LIMIT ?`,
      e.n,
      this.now,
      focus ? 64 : 32,
    )) {
      this.mention(e, id)
      if (depth === 0 && this.memories.has(id)) this.pending.add(id)
    }
    if (depth === 2 || this.relations.size >= 600) return
    for (const link of edgesAt(this.ctx, e, 8, this.now, true)) this.relation(e, link)
  }
  private relation(e: EntityNode, link: BrainLink) {
    if (this.relations.has(link.id) || this.relations.size >= 600) return
    const entityId = link.subjectId === e.id ? link.objectId : link.subjectId
    const other = this.entity(
      entityId,
      e.trail ? { ...e.trail, entityId, links: [...e.trail.links, link] } : null,
    )
    if (!other) return
    const weight = STRUCTURAL.has(link.predicate) ? this.tuning.structural : this.tuning.relation
    const before = this.adj[e.index]!.get(other.index) ?? 0
    this.connect(e.index, other.index, before + weight)
    this.relations.add(link.id)
  }
  /** A shared memory is two hops from one entity to the next. Admit its other endpoints at
   * depth two. A co-mention is not a relation and must not invent a sentence trail. */
  coMentioned() {
    if (!this.pending.size) return
    for (const row of all<{ id: string; entityId: string }>(
      this.ctx,
      `SELECT m.id,e.id AS entityId FROM json_each(?) j
      CROSS JOIN memories m ON m.id=j.value CROSS JOIN mentions a ON a.memory=m.n CROSS JOIN entities e ON e.n=a.entity`,
      JSON.stringify([...this.pending]),
    )) {
      const e = this.entity(row.entityId, null)
      if (e) this.mention(e, row.id)
    }
  }
  explain() {
    const byIndex = new Map([...this.memories].map(([id, index]) => [index, id]))
    for (const e of this.entities.values()) {
      if (!e.trail) continue
      for (const index of this.adj[e.index]!.keys()) {
        const id = byIndex.get(index)
        if (!id || this.seeds.memories.has(id)) continue
        const old = this.explanations.get(id)
        if (!old || e.trail.links.length < old.links.length) this.explanations.set(id, e.trail)
      }
    }
  }
}

/** Power iteration over just the admitted edges; redistribute all dangling mass to the seeds. */
function iterate(adj: Adj, seeds: number[], { iterations, alpha }: RecallTuning) {
  const sum = seeds.reduce((a, b) => a + b, 0) || 1
  const p = Float64Array.from(seeds, (w) => w / sum)
  let r = p.slice(),
    next = new Float64Array(p.length)
  const offsets = new Int32Array(p.length + 1),
    targets: number[] = [],
    weights: number[] = []
  adj.forEach((edges, i) => {
    const total = [...edges.values()].reduce((a, b) => a + b, 0)
    for (const [target, w] of edges) {
      targets.push(target)
      weights.push(((1 - alpha) * w) / total)
    }
    offsets[i + 1] = targets.length
  })
  for (let t = 0; t < iterations; t++) {
    next.fill(0)
    let restart = alpha
    for (let i = 0; i < r.length; i++) {
      const end = offsets[i + 1]!
      if (end === offsets[i]) restart += (1 - alpha) * r[i]!
      for (let j = offsets[i]!; j < end; j++) next[targets[j]!]! += r[i]! * weights[j]!
    }
    for (let i = 0; i < next.length; i++) next[i]! += p[i]! * restart
    ;[r, next] = [next, r]
  }
  return r
}
export function ppr(ctx: Context, seeds: Seeds, now: number, tuning = RECALL_TUNING) {
  const graph = new LocalGraph(ctx, now, seeds, tuning)
  graph.seed()
  let reached = 0
  for (let depth = 0; depth <= 2; depth++) {
    const nodes = [...graph.entities.values()].slice(reached)
    reached = graph.entities.size
    for (const e of nodes) graph.expand(e, depth)
    if (depth === 1) graph.coMentioned()
  }
  graph.explain()
  const rank = iterate(graph.adj, graph.personalization, tuning)
  const sorted = <T extends { index: number }>(a: T, b: T) => rank[b.index]! - rank[a.index]!
  const memories = [...graph.memories]
    .sort((a, b) => rank[b[1]]! - rank[a[1]]!)
    .slice(0, 100)
    .map(([id]) => id)
  return {
    memories,
    trails: graph.explanations,
    entities: [...graph.entities.values()].sort(sorted).map((e) => e.id),
  }
}
