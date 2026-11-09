import { useMemo, useRef, useState } from 'react'
import type { BrainEntity, BrainEntityKind, BrainMemory } from '@shared/brain'
import { Button } from '@/components/form'
import { graphEdges, graphLabel, zoomView, type GraphEdge, type GraphNode } from './graphLayout'
import { useForceLayout } from './useForceLayout'
import { useGraphSize, useGraphViewport } from './useGraphViewport'
import { useGraphDrag, useGraphWheel } from './useGraphGestures'

const COLORS: Record<BrainEntityKind, string> = {
  person: 'var(--px-accent)',
  team: 'var(--px-success)',
  organization: 'var(--px-warning)',
  project: 'var(--px-text)',
  component: 'var(--px-text-secondary)',
  document: 'var(--px-danger)',
  concept: 'var(--px-text-tertiary)',
  event: 'var(--px-border-strong)',
}

export function BrainGraph({
  entities,
  memories,
  focus,
  onFocus,
}: {
  entities: BrainEntity[]
  memories: BrainMemory[]
  focus: string | null
  onFocus: (id: string) => void
}): React.JSX.Element {
  const edges = useMemo(() => graphEdges(memories), [memories])
  const layout = useForceLayout(entities, edges)
  const [hover, setHover] = useState<string | null>(null)
  const pane = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const size = useGraphSize(pane)
  const { view, setView, fit, cancelPan } = useGraphViewport(
    layout.nodes,
    layout.settled,
    focus,
    size,
  )
  const gestures = useGraphDrag(svg, view, setView, layout, size, onFocus, cancelPan)
  useGraphWheel(svg, setView, size, cancelPan)
  const neighbors = new Set([
    hover,
    ...edges.flatMap((edge) =>
      edge.source === hover ? [edge.target] : edge.target === hover ? [edge.source] : [],
    ),
  ])
  const zoom = (factor: number): void => {
    cancelPan()
    setView((previous) => zoomView(previous, factor, { x: size.width / 2, y: size.height / 2 }))
  }
  return (
    <section
      aria-label="Knowledge graph"
      className="border-border bg-bg-secondary/40 flex min-h-64 flex-1 flex-col rounded-lg border"
    >
      <GraphToolbar kinds={[...new Set(entities.map((e) => e.kind))]} zoom={zoom} fit={fit} />
      <div ref={pane} className="relative min-h-0 flex-1 overflow-hidden">
        <svg
          ref={svg}
          aria-label="Memory relationships"
          className="absolute inset-0 h-full w-full touch-none select-none"
          viewBox={`0 0 ${size.width} ${size.height}`}
          {...gestures}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            <GraphEdges nodes={layout.nodes} edges={edges} hover={hover} />
            <GraphNodes
              nodes={layout.nodes}
              entities={entities}
              focus={focus}
              onFocus={onFocus}
              hover={hover}
              neighbors={neighbors}
              setHover={setHover}
            />
          </g>
        </svg>
      </div>
    </section>
  )
}

function GraphNodes({
  nodes,
  entities,
  focus,
  onFocus,
  hover,
  neighbors,
  setHover,
}: {
  nodes: GraphNode[]
  entities: BrainEntity[]
  focus: string | null
  onFocus: (id: string) => void
  hover: string | null
  neighbors: Set<string | null>
  setHover: (id: string | null) => void
}): React.JSX.Element {
  const kinds = new Map(entities.map((entity) => [entity.id, entity.kind]))
  return (
    <>
      {nodes.map((node) => (
        <g
          key={node.id}
          data-node={node.id}
          role="button"
          tabIndex={0}
          aria-label={`Focus ${node.label}`}
          aria-pressed={focus === node.id}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onFocus(node.id)
            }
          }}
          onMouseEnter={() => setHover(node.id)}
          onMouseLeave={() => setHover(null)}
          transform={`translate(${node.x} ${node.y})`}
          opacity={hover && !neighbors.has(node.id) ? 0.25 : 1}
          className="cursor-grab"
        >
          <title>{node.label}</title>
          {focus === node.id && (
            <circle r={node.radius + 3} fill="none" stroke="var(--px-accent)" strokeWidth={1.5} />
          )}
          <circle r={node.radius} fill={COLORS[kinds.get(node.id)!]} />
          <text x={node.radius + 6} y={4} fill="var(--px-text)" fontSize={12}>
            {graphLabel(node.label)}
          </text>
        </g>
      ))}
    </>
  )
}

function GraphEdges({
  nodes,
  edges,
  hover,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  hover: string | null
}): React.JSX.Element {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return (
    <>
      {edges.map((edge, index) => {
        const a = byId.get(edge.source),
          b = byId.get(edge.target)
        if (!a || !b) return null
        const highlighted = a.id === hover || b.id === hover
        return (
          <g key={index}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={highlighted ? 'var(--px-accent)' : 'var(--px-border-strong)'}
              strokeWidth={1}
              opacity={hover && !highlighted ? 0.2 : 1}
            />
            {highlighted && (
              <text
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2 - 4}
                textAnchor="middle"
                fontSize={10}
                fill="var(--px-accent)"
                stroke="var(--px-bg)"
                strokeWidth={3}
                paintOrder="stroke"
                pointerEvents="none"
              >
                {edge.predicate}
              </text>
            )}
          </g>
        )
      })}
    </>
  )
}

function GraphToolbar({
  kinds,
  zoom,
  fit,
}: {
  kinds: BrainEntityKind[]
  zoom: (factor: number) => void
  fit: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-3">
      <div aria-label="Entity kinds" className="text-text-tertiary flex flex-wrap gap-3 text-sm">
        {kinds.map((kind) => (
          <span key={kind} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: COLORS[kind] }} />
            {kind}
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <Button size="xs" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}>
          −
        </Button>
        <Button size="xs" aria-label="Zoom in" onClick={() => zoom(1.2)}>
          +
        </Button>
        <Button size="xs" onClick={fit}>
          Fit
        </Button>
      </div>
    </div>
  )
}
