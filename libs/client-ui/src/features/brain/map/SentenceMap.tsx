import { useMemo, useRef, useState } from 'react'
import type { BrainLink } from '@shared/brain'
import { Button, NeutralSegmented } from '@/components/form'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { useBoxSize } from '../useBoxSize'
import type { MapNode } from '../explorer/mapLayout'
import { placeEdgeLabels } from './edgeLabels'
import { MapDefs, MapEdgeMark, MapNodeMark } from './MapMarks'
import { MapLegend } from './MapLegend'
import { useSentenceMap, type MapOverlay, type SentenceEdge } from './useSentenceMap'

/** jsdom and the first paint have no ResizeObserver size yet. */
const MAP_FALLBACK = { width: 640, height: 420 }
const HOP_OPTIONS = [
  { id: '1' as const, label: '1 step' },
  { id: '2' as const, label: '2 steps' },
]

export interface MapStep {
  to: { id: string; label: string }
  /** The relationship followed, when the step went along one. */
  link: BrainLink | null
}

/**
 * The centre and the people and things around it, every line a relationship that says its
 * sentence: on hover or focus, along the walk, and along an answer's trail. Ended
 * relationships are dashed with their end date.
 */
export function SentenceMap({
  centreId,
  hops,
  onHops,
  trail,
  overlay,
  onStep,
  onWhole,
}: {
  centreId: string
  hops: 1 | 2
  onHops: (hops: 1 | 2) => void
  /** Links the walk followed up to the step on screen. */
  trail: BrainLink[]
  overlay: MapOverlay | null
  onStep: (step: MapStep) => void
  onWhole: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const { width, height } = useBoxSize(box, MAP_FALLBACK)
  const { map, error, retry } = useSentenceMap(centreId, hops, overlay, width, height)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate">
          <SectionLabel>Map{map ? ` · ${map.label}` : ''}</SectionLabel>
        </span>
        <NeutralSegmented
          value={String(hops) as '1' | '2'}
          onChange={(value) => onHops(Number(value) as 1 | 2)}
          options={HOP_OPTIONS}
        />
        <Button size="xs" tooltip="Every person and thing, in 3D" onClick={onWhole}>
          Whole graph
        </Button>
      </header>
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        {!map ? (
          <p role="status" className="p-3 text-sm">
            {error || 'Loading map…'}{' '}
            {error && (
              <Button size="xs" onClick={retry}>
                Retry
              </Button>
            )}
          </p>
        ) : (
          <MapDrawing
            layout={map.layout}
            label={map.label}
            width={width}
            height={height}
            trail={trail}
            overlay={overlay}
            onStep={onStep}
          />
        )}
        {!!map?.layout.hidden && (
          <span className="bg-surface text-text-tertiary absolute right-2 bottom-2 rounded-sm px-1.5 text-xs">
            +{map.layout.hidden} more around {map.label}
          </span>
        )}
      </div>
      {map && <MapLegend nodes={map.layout.nodes} />}
    </div>
  )
}

function MapDrawing({
  layout,
  label,
  width,
  height,
  trail,
  overlay,
  onStep,
}: {
  layout: { nodes: MapNode[]; edges: SentenceEdge[] }
  label: string
  width: number
  height: number
  trail: BrainLink[]
  overlay: MapOverlay | null
  onStep: (step: MapStep) => void
}): React.JSX.Element {
  const [hover, setHover] = useState<string | null>(null)
  const at = new Map(layout.nodes.map((node) => [node.id, node]))
  const centre = layout.nodes.find((node) => node.ring === 0)
  const litIds = useMemo(
    () => new Set([...trail, ...(overlay?.links ?? [])].map((link) => link.id)),
    [trail, overlay],
  )
  const litEntities = new Set(overlay?.entities.map((e) => e.id))
  const lit = (edge: SentenceEdge): boolean => edge.links.some((link) => litIds.has(link.id))
  const touchesCentre = (edge: SentenceEdge): boolean =>
    !!centre && (edge.from === centre.id || edge.to === centre.id)
  const labels = placeEdgeLabels(
    layout.edges
      .filter((edge) => touchesCentre(edge) && !lit(edge))
      .map((edge) => ({ key: edge.key, text: edge.words, ...ends(edge, at) })),
    layout.nodes,
    width,
    height,
  )
  const sentences = layout.edges.filter((edge) => lit(edge) || edge.key === hover)
  const step = (edge: SentenceEdge): void => {
    const toId = centre && edge.to === centre.id ? edge.from : edge.to
    const to = at.get(toId)!
    onStep({ to: { id: to.id, label: to.label }, link: edge.links[0] ?? null })
  }
  return (
    <>
      <svg
        role="group"
        aria-label={`Map of ${label} and its neighbours`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block"
      >
        <MapDefs />
        {layout.edges.map((edge) => (
          <MapEdgeMark
            key={edge.key}
            edge={edge}
            from={at.get(edge.from)!}
            to={at.get(edge.to)!}
            lit={lit(edge) || edge.key === hover}
            label={labels.get(edge.key)}
            onHover={setHover}
            onStep={() => step(edge)}
          />
        ))}
        {layout.nodes.map((node) => (
          <MapNodeMark
            key={node.id}
            node={node}
            lit={litEntities.has(node.id)}
            dim={
              (litIds.size > 0 &&
                node.ring !== 0 &&
                !litEntities.has(node.id) &&
                !onTrail(node.id, layout.edges, lit)) ||
              (node.ring === 2 && !hover)
            }
            onStep={() =>
              onStep({
                to: { id: node.id, label: node.label },
                link: linkTo(node.id, centre, layout.edges),
              })
            }
          />
        ))}
      </svg>
      {sentences.map((edge) => {
        const { x1, y1, x2, y2 } = ends(edge, at)
        return (
          <p
            key={edge.key}
            data-edge-sentence=""
            className="brain-map-sentence"
            style={{
              left: Math.min(Math.max((x1 + x2) / 2, 110), Math.max(110, width - 110)),
              top: Math.min(Math.max((y1 + y2) / 2, 16), Math.max(16, height - 16)),
            }}
          >
            {edge.sentences.join('; ')}
          </p>
        )
      })}
    </>
  )
}

function ends(edge: SentenceEdge, at: Map<string, MapNode>) {
  const a = at.get(edge.from)!,
    b = at.get(edge.to)!
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
}

function onTrail(id: string, edges: SentenceEdge[], lit: (edge: SentenceEdge) => boolean): boolean {
  return edges.some((edge) => lit(edge) && (edge.from === id || edge.to === id))
}

/** The relationship that joins a clicked neighbour to the centre, so the walk can say it. */
function linkTo(id: string, centre: MapNode | undefined, edges: SentenceEdge[]): BrainLink | null {
  if (!centre || centre.id === id) return null
  const edge = edges.find(
    (e) => (e.from === id && e.to === centre.id) || (e.to === id && e.from === centre.id),
  )
  return edge?.links[0] ?? null
}
