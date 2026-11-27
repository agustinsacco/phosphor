import { useMemo, useRef } from 'react'
import type { BrainGraph, BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { layoutMap } from './explorer/mapLayout'
import { MapDrawing, type MapStep } from './map/SentenceMap'
import { withSentences, type MapOverlay } from './map/useSentenceMap'
import { useBoxSize } from './useBoxSize'

const HOST_MAP_SIZE = { width: 380, height: 380 }

export function HostNeighbourMap({
  graph,
  centre,
  overlay,
  step,
  trail,
  hops,
  retry,
  error,
  empty,
}: {
  graph: BrainGraph | undefined
  centre: string | null
  overlay: MapOverlay | null
  step: (step: MapStep) => void
  trail: BrainLink[]
  hops: 1 | 2
  retry: () => void
  error: boolean
  empty: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const { width, height } = useBoxSize(box, HOST_MAP_SIZE)
  const drawing = useMemo(() => {
    if (!graph || !centre) return null
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
    for (const e of overlay?.entities ?? [])
      if (!nodes.has(e.id)) nodes.set(e.id, { ...e, memories: 1, connections: 0 })
    const links = new Map(
      [...graph.links, ...graph.ended, ...(overlay?.links ?? [])].map((link) => [link.id, link]),
    )
    const label = (id: string) => nodes.get(id)?.label ?? id
    const layout = layoutMap({
      centerId: centre,
      nodes: [...nodes.values()],
      links: [...links.values()],
      hops,
      width,
      height,
    })
    return { layout: withSentences(layout, label, Date.now()), label: label(centre) }
  }, [centre, graph, overlay, hops, width, height])
  return (
    <div ref={box} className="relative h-[380px] min-w-0 overflow-hidden">
      {drawing ? (
        <MapDrawing
          width={width}
          height={height}
          layout={drawing.layout}
          label={drawing.label}
          trail={trail}
          overlay={overlay}
          onStep={step}
        />
      ) : (
        <p role="status">
          {error ? (
            <>
              The Host did not provide this map. <Button onClick={retry}>Retry</Button>
            </>
          ) : empty ? (
            'Brain knows no one yet.'
          ) : (
            'Loading map…'
          )}
        </p>
      )}
    </div>
  )
}
