import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { BrainEntity, BrainEntityKind, BrainMemory } from '@shared/brain'
import { Button } from '@/components/form'
import {
  fitGraph,
  graphEdges,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  layoutGraph,
  separateLabels,
  svgPoint,
  worldPoint,
  zoomView,
  type GraphEdge,
  type GraphNode,
  type Point,
  type View,
} from './graphLayout'

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
interface Drag {
  id: string | null
  start: Point
  last: Point
  view: View
  moved: boolean
}
type SetView = Dispatch<SetStateAction<View>>

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
  const initial = useMemo(() => layoutGraph(entities, edges), [entities, edges])
  const [nodes, setNodes] = useState(initial)
  const [view, setView] = useState(() => fitGraph(initial))
  const [hover, setHover] = useState<string | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  useEffect(() => {
    setNodes(initial)
    setView(fitGraph(initial))
  }, [initial])
  const gestures = useGraphDrag(svg, view, setView, setNodes, onFocus)
  useGraphWheel(svg, setView)
  const neighbors = new Set([
    hover,
    ...edges.flatMap((edge) =>
      edge.source === hover ? [edge.target] : edge.target === hover ? [edge.source] : [],
    ),
  ])
  const zoom = (factor: number): void =>
    setView((previous) => zoomView(previous, factor, { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }))
  return (
    <section
      aria-label="Knowledge graph"
      className="border-border bg-bg-secondary/40 rounded-lg border"
    >
      <GraphToolbar
        kinds={[...new Set(entities.map((e) => e.kind))]}
        zoom={zoom}
        fit={() => setView(fitGraph(nodes))}
      />
      <svg
        ref={svg}
        aria-label="Memory relationships"
        className="h-80 w-full touch-none select-none"
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        {...gestures}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          <GraphEdges nodes={nodes} edges={edges} hover={hover} neighbors={neighbors} />
          <GraphNodes
            nodes={nodes}
            entities={entities}
            focus={focus}
            onFocus={onFocus}
            hover={hover}
            neighbors={neighbors}
            setHover={setHover}
          />
        </g>
      </svg>
    </section>
  )
}

function useGraphDrag(
  svg: React.RefObject<SVGSVGElement | null>,
  view: View,
  setView: SetView,
  setNodes: Dispatch<SetStateAction<GraphNode[]>>,
  onFocus: (id: string) => void,
): Pick<
  React.SVGProps<SVGSVGElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'
> {
  const drag = useRef<Drag | null>(null)
  const point = (event: { clientX: number; clientY: number }): Point =>
    svgPoint({ x: event.clientX, y: event.clientY }, svg.current!.getBoundingClientRect())
  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return
      const target = (event.target as Element).closest('[data-node]')
      drag.current = {
        id: target?.getAttribute('data-node') ?? null,
        start: point(event),
        last: point(event),
        view,
        moved: false,
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event) => {
      const current = drag.current
      if (!current) return
      const next = point(event)
      if (Math.hypot(next.x - current.start.x, next.y - current.start.y) > 3) current.moved = true
      if (!current.moved) return
      if (current.id) {
        const nextWorld = worldPoint(next, view)
        const lastWorld = worldPoint(current.last, view)
        current.last = next
        setNodes((previous) =>
          separateLabels(
            previous.map((node) =>
              node.id === current.id
                ? {
                    ...node,
                    x: node.x + nextWorld.x - lastWorld.x,
                    y: node.y + nextWorld.y - lastWorld.y,
                  }
                : node,
            ),
          ),
        )
      } else
        setView({
          ...current.view,
          x: current.view.x + next.x - current.start.x,
          y: current.view.y + next.y - current.start.y,
        })
    },
    onPointerUp: () => {
      const current = drag.current
      if (current?.id && !current.moved) onFocus(current.id)
      if (current?.moved && current.id) setNodes(separateLabels)
      drag.current = null
    },
    onPointerCancel: () => {
      setNodes(separateLabels)
      drag.current = null
    },
  }
}

function useGraphWheel(svg: React.RefObject<SVGSVGElement | null>, setView: SetView): void {
  useEffect(() => {
    const element = svg.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const anchor = svgPoint(
        { x: event.clientX, y: event.clientY },
        element.getBoundingClientRect(),
      )
      setView((previous) => zoomView(previous, Math.exp(-event.deltaY * 0.005), anchor))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [svg, setView])
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
          <rect
            x={-node.width / 2}
            y={-14}
            width={node.width}
            height={28}
            rx={7}
            fill="var(--px-bg)"
            stroke={focus === node.id ? 'var(--px-accent)' : 'var(--px-border)'}
          />
          <circle cx={-node.width / 2 + 12} r={4} fill={COLORS[kinds.get(node.id)!]} />
          <text x={8} y={5} textAnchor="middle" fill="var(--px-text)" fontSize={14}>
            {node.label}
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
  neighbors,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  hover: string | null
  neighbors: Set<string | null>
}): React.JSX.Element {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return (
    <>
      {edges.map((edge, index) => {
        const a = byId.get(edge.source),
          b = byId.get(edge.target)
        return a && b ? (
          <line
            key={index}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="var(--px-border-strong)"
            strokeWidth={hover && (a.id === hover || b.id === hover) ? 2 : 1}
            opacity={hover && (!neighbors.has(a.id) || !neighbors.has(b.id)) ? 0.2 : 1}
          />
        ) : null
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
