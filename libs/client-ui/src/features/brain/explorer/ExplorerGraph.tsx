import { useCallback, useEffect, useState } from 'react'
import type { BrainGraph, BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { useBrainResource } from '../useBrainResource'
import { BrainGraph3D } from '../BrainGraph3D'
import type { BrainVisit } from './trail'
export function ExplorerGraph({
  entityId,
  path,
  onVisit,
}: {
  entityId: string | null
  path: BrainLink[] | null
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const [hops, setHops] = useState<1 | 2>(1)
  const load = useCallback(async () => {
    const graph = entityId
      ? await window.phosphor.invoke('brain:neighbourhood', entityId, hops)
      : await window.phosphor.invoke('brain:overview')
    return includePath(graph, path)
  }, [entityId, hops, path])
  const { data, error, retry } = useBrainResource(load)
  const [previous, setPrevious] = useState<BrainGraph | null>(null)
  useEffect(() => {
    if (data) setPrevious(data)
  }, [data])
  const shown = data ?? previous
  return (
    <section aria-label="Graph explorer" className="flex h-full min-h-80 flex-col gap-2 p-3">
      <div className="flex gap-2">
        <h2 className="flex-1 font-medium">{entityId ? 'Neighbourhood' : 'Overview'}</h2>
        {entityId && (
          <>
            <Button size="xs" aria-pressed={hops === 1} onClick={() => setHops(1)}>
              1 hop
            </Button>
            <Button size="xs" aria-pressed={hops === 2} onClick={() => setHops(2)}>
              2 hops
            </Button>
          </>
        )}
      </div>
      {!data && (
        <p role="status">
          {error || 'Loading graph…'}
          {error && <Button onClick={retry}>Retry</Button>}
        </p>
      )}
      {shown &&
        (!shown.nodes.length ? (
          <p>No knowledge yet. Right-click a lane and choose Queue for knowledge extraction.</p>
        ) : (
          <>
            {shown.truncated && (
              <p className="text-text-tertiary text-sm">
                Showing a bounded selection of the graph. Search to explore further.
              </p>
            )}
            <BrainGraph3D
              graph={shown}
              path={path}
              focus={entityId}
              onFocus={(id) =>
                onVisit({
                  kind: 'entity',
                  id,
                  label: shown.nodes.find((node) => node.id === id)?.label ?? id,
                })
              }
            />
          </>
        ))}
    </section>
  )
}

/** A four-hop route may extend beyond the selected neighbourhood. Fetch only its missing nodes. */
async function includePath(graph: BrainGraph, path: BrainLink[] | null): Promise<BrainGraph> {
  if (!path) return graph
  const ids = new Set(graph.nodes.map((node) => node.id))
  const missing = [...new Set(path.flatMap((link) => [link.subjectId, link.objectId]))].filter(
    (id) => !ids.has(id),
  )
  const extra = await Promise.all(missing.map((id) => window.phosphor.invoke('brain:entity', id)))
  const links = new Map([...graph.links, ...path].map((link) => [link.id, link]))
  // Keep the read bounded at 300 nodes even when the route adds nodes to a full neighbourhood.
  const routeIds = new Set(path.flatMap((link) => [link.subjectId, link.objectId]))
  const nodes = [...graph.nodes, ...extra.map((view) => view.entity)]
    .sort((a, b) => Number(routeIds.has(b.id)) - Number(routeIds.has(a.id)))
    .slice(0, 300)
  const shown = new Set(nodes.map((node) => node.id))
  return {
    ...graph,
    nodes,
    links: [...links.values()].filter(
      (link) => shown.has(link.subjectId) && shown.has(link.objectId),
    ),
    truncated: graph.truncated || graph.nodes.length + extra.length > 300,
  }
}
