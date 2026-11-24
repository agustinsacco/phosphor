import type { BrainGraph, BrainLink } from '@shared/brain'

/** Prioritize a selected thing or route without letting additions exceed the 300-node bound. */
export function combineGraphs(graphs: BrainGraph[], priority: string[] = []): BrainGraph {
  const nodes = new Map(graphs.flatMap((g) => g.nodes).map((n) => [n.id, n]))
  const important = new Map([...new Set(priority)].map((id, index) => [id, index]))
  const selected = [...nodes.values()]
    .sort((a, b) => (important.get(a.id) ?? Infinity) - (important.get(b.id) ?? Infinity))
    .slice(0, 300)
  const ids = new Set(selected.map((n) => n.id))
  return {
    nodes: selected,
    links: [...new Map(graphs.flatMap((g) => g.links).map((l) => [l.id, l])).values()].filter(
      (l) => ids.has(l.subjectId) && ids.has(l.objectId),
    ),
    ended: [],
    centerId: null,
    truncated: nodes.size > 300 || graphs.some((g) => g.truncated),
  }
}

export async function includePath(
  graph: BrainGraph,
  path: BrainLink[] | null,
  priority: string[] = [],
): Promise<BrainGraph> {
  if (!path?.length) return graph
  const ids = [...new Set(path.flatMap((l) => [l.subjectId, l.objectId]))]
  const missing = ids.filter((id) => !graph.nodes.some((n) => n.id === id))
  const extra = await Promise.all(missing.map((id) => window.phosphor.invoke('brain:entity', id)))
  return combineGraphs(
    [
      graph,
      {
        nodes: extra.map((v) => v.entity),
        links: path,
        ended: [],
        centerId: null,
        truncated: false,
      },
    ],
    [...priority, ...ids],
  )
}
