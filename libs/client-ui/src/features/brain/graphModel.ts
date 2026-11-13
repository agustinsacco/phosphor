import type { BrainEntityKind, BrainGraph, BrainMemory, BrainPredicate } from '@shared/brain'

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
  id: string
  memoryId: string
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
  return new Set(memories.flatMap((memory) => memory.entityIds))
}
/** A bounded server projection. Keep direction and support ids, including parallel edges. */
export function graphModel(graph: BrainGraph): GraphModel {
  const known = new Set(graph.nodes.map((node) => node.id))
  return {
    nodes: graph.nodes.map((entity) => ({
      id: entity.id,
      label: entity.label,
      kind: entity.kind,
      memories: entity.memories,
      degree: entity.connections,
      val: 1 + entity.memories + entity.connections,
    })),
    links: graph.links
      .filter(
        (link) =>
          link.subjectId !== link.objectId && known.has(link.subjectId) && known.has(link.objectId),
      )
      .map((link) => ({
        id: link.id,
        memoryId: link.memoryId,
        source: link.subjectId,
        target: link.objectId,
        count: 1,
        predicates: [link.predicate],
      })),
  }
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
