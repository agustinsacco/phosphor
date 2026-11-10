import type { BrainEntity, BrainEntityKind, BrainMemory, BrainPredicate } from '@shared/brain'

export interface GraphNode {
  id: string
  label: string
  kind: BrainEntityKind
  memories: number
  degree: number
  /** ForceGraph renders a sphere whose radius is nodeRelSize * cbrt(val). */
  val: number
  x?: number
  y?: number
  z?: number
}

export interface GraphLink {
  source: string | GraphNode
  target: string | GraphNode
  count: number
  predicates: BrainPredicate[]
}

export interface GraphModel {
  nodes: GraphNode[]
  links: GraphLink[]
}

export function memoryEntityIds(memories: BrainMemory[]): Set<string> {
  return new Set(
    memories.flatMap((memory) => [memory.subjectId, ...(memory.objectId ? [memory.objectId] : [])]),
  )
}

/** Inputs are active memories only. Count each memory once per mentioned entity. */
export function graphModel(entities: BrainEntity[], memories: BrainMemory[]): GraphModel {
  const known = new Set(entities.map((entity) => entity.id))
  const mentions = new Map<string, number>()
  const neighbors = new Map<string, Set<string>>()
  const pairs = new Map<string, GraphLink>()
  for (const memory of memories) {
    for (const id of memoryEntityIds([memory])) mentions.set(id, (mentions.get(id) ?? 0) + 1)
    const { subjectId, objectId, predicate } = memory
    if (!objectId || subjectId === objectId || !known.has(subjectId) || !known.has(objectId))
      continue
    const [source, target] = [subjectId, objectId].sort() as [string, string]
    const key = JSON.stringify([source, target])
    const link = pairs.get(key) ?? { source, target, count: 0, predicates: [] }
    link.count++
    if (!link.predicates.includes(predicate)) link.predicates.push(predicate)
    link.predicates.sort()
    pairs.set(key, link)
    for (const [a, b] of [
      [source, target],
      [target, source],
    ] as const) {
      const linked = neighbors.get(a) ?? new Set<string>()
      linked.add(b)
      neighbors.set(a, linked)
    }
  }
  const nodes = entities
    .filter((entity) => mentions.has(entity.id))
    .map((entity) => {
      const count = mentions.get(entity.id)!
      const degree = neighbors.get(entity.id)?.size ?? 0
      return {
        id: entity.id,
        label: entity.label,
        kind: entity.kind,
        memories: count,
        degree,
        val: 1 + count + degree,
      }
    })
  return { nodes, links: [...pairs.values()] }
}

export const graphEndpoint = (endpoint: string | GraphNode): string =>
  typeof endpoint === 'string' ? endpoint : endpoint.id

export function graphNeighbors(model: GraphModel, hover: string | null): Set<string> {
  const neighbors = new Set<string>(hover ? [hover] : [])
  for (const link of model.links) {
    const source = graphEndpoint(link.source),
      target = graphEndpoint(link.target)
    if (source === hover) neighbors.add(target)
    if (target === hover) neighbors.add(source)
  }
  return neighbors
}
