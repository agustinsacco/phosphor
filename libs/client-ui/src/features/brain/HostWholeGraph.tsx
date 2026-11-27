import type { GraphLink } from './graphModel'
import { useMemo, useState } from 'react'
import type { BrainGraph, BrainLink } from '@shared/brain'
import { Button, NeutralSegmented } from '@/components/form'
import { BrainGraph3D } from './BrainGraph3D'
import { combineGraphs } from './explorer/graphProjection'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'
import type { MapOverlay } from './map/useSentenceMap'

export function HostWholeGraph({
  brain,
  overview,
  focus,
  overlay,
  trail,
  visit,
  close,
  openMemory,
}: {
  brain: ReadyBrainSurface
  overview: BrainGraph | undefined
  focus: string | null
  overlay: MapOverlay | null
  trail: BrainLink[]
  visit: (id: string) => void
  close: () => void
  openMemory: (id: string) => void
}) {
  const [near, setNear] = useState(false)
  const [hops, setHops] = useState<1 | 2>(1)
  const neighbours = useBrainRequest<'brain:neighbourhood'>(
    brain,
    focus ? { method: 'brain:neighbourhood', args: [focus, hops] } : null,
  )
  const graph = useMemo(
    () => wholeGraph(near ? undefined : overview, neighbours.data, overlay, focus),
    [near, overview, neighbours.data, overlay, focus],
  )
  return (
    <section aria-label="Whole graph" className="space-y-2">
      <Button onClick={close}>Back to the map</Button>
      {focus && (
        <NeutralSegmented
          value={near ? 'near' : 'all'}
          options={[
            { id: 'all', label: 'Whole graph' },
            { id: 'near', label: 'Neighbours only' },
          ]}
          onChange={(v) => setNear(v === 'near')}
        />
      )}
      {near && focus && (
        <NeutralSegmented
          value={hops === 1 ? '1' : '2'}
          options={[
            { id: '1', label: '1 step' },
            { id: '2', label: '2 steps' },
          ]}
          onChange={(v) => setHops(v === '1' ? 1 : 2)}
        />
      )}
      {neighbours.error && (
        <p role="status">
          Neighbours unavailable. <Button onClick={neighbours.retry}>Retry</Button>
        </p>
      )}
      {graph ? (
        <>
          {graph.truncated && <p>Showing a bounded selection of the graph.</p>}
          <BrainGraph3D
            graph={graph}
            focus={focus}
            scope={near ? 'near' : 'all'}
            path={[...trail, ...(overlay?.links ?? [])]}
            onFocus={visit}
            renderEdge={(edge) => (
              <WholeGraphEdge
                edge={edge}
                openMemory={brain.access.includes('evidence') ? openMemory : undefined}
              />
            )}
          />
        </>
      ) : (
        <p role="status">Loading graph…</p>
      )}
    </section>
  )
}

function wholeGraph(
  overview: BrainGraph | undefined,
  neighbours: BrainGraph | undefined,
  overlay: MapOverlay | null,
  focus: string | null,
) {
  const parts: BrainGraph[] = []
  if (overview) parts.push(overview)
  if (neighbours) parts.push(neighbours)
  if (overlay)
    parts.push({
      nodes: overlay.entities.map((e) => ({ ...e, memories: 1, connections: 0 })),
      links: overlay.links,
      ended: [],
      centerId: focus,
      truncated: false,
    })
  return parts.length ? combineGraphs(parts, focus ? [focus] : []) : null
}

function WholeGraphEdge({
  edge,
  openMemory,
}: {
  edge: GraphLink
  openMemory?: (id: string) => void
}) {
  return (
    <p role="status">
      {edge.sentences.join('; ')}{' '}
      {openMemory && (
        <Button size="xs" onClick={() => openMemory(edge.memoryId)}>
          Supporting memory
        </Button>
      )}
    </p>
  )
}
