import clsx from 'clsx'
import { formatCount } from '@/lib/format'
import { GRAPH_COLORS } from '../graphColors'
import { ENTITY_WORDS } from '../memoryLabels'
import type { MapNode } from '../explorer/mapLayout'
import type { EdgeLabel } from './edgeLabels'
import type { SentenceEdge } from './useSentenceMap'

/** A point `by` pixels from `from` towards `to`, so lines stop at a node's rim. */
function toward(from: MapNode, to: MapNode, by: number): { x: number; y: number } {
  const dx = to.x - from.x,
    dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  return { x: from.x + (dx / length) * by, y: from.y + (dy / length) * by }
}

/** One line between two drawn entities; its links say their sentences on hover and focus. */
export function MapEdgeMark({
  edge,
  from,
  to,
  lit,
  label,
  onHover,
  onStep,
}: {
  edge: SentenceEdge
  from: MapNode
  to: MapNode
  lit: boolean
  label: EdgeLabel | undefined
  onHover: (key: string | null) => void
  onStep: () => void
}): React.JSX.Element {
  // A single link reads subject to object, so the arrow points at the object.
  const single = edge.links.length === 1 ? edge.links[0]! : null
  const [tail, head] = single && single.subjectId === to.id ? [to, from] : [from, to]
  const start = toward(tail, head, tail.r + 1)
  const end = toward(head, tail, head.r + (single ? 3 : 1))
  const sentence = edge.sentences.join('; ')
  return (
    <g
      data-edge={edge.key}
      data-ended={edge.ended}
      data-lit={lit}
      role="button"
      tabIndex={0}
      aria-label={sentence}
      className="brain-map-edge cursor-pointer outline-none"
      onMouseEnter={() => onHover(edge.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(edge.key)}
      onBlur={() => onHover(null)}
      onClick={onStep}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onStep()
        }
      }}
    >
      <title>{sentence}</title>
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        className={clsx('brain-map-line', lit && 'brain-map-line--lit')}
        strokeDasharray={edge.ended ? '4 3' : undefined}
        markerEnd={single ? `url(#${lit ? 'brain-arrow-lit' : 'brain-arrow'})` : undefined}
      />
      {/* A wide invisible stroke makes a thin line easy to point at. */}
      <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="transparent" strokeWidth={12} />
      {label && (
        <text
          x={label.x}
          y={label.y}
          textAnchor="middle"
          className="brain-map-words"
          data-edge-words=""
        >
          {label.text}
        </text>
      )}
    </g>
  )
}

export function MapNodeMark({
  node,
  dim,
  lit,
  onStep,
}: {
  node: MapNode
  dim: boolean
  lit: boolean
  onStep: () => void
}): React.JSX.Element {
  const name = `${node.label}, ${ENTITY_WORDS[node.kind]}, ${formatCount(node.memories, 'memory', 'memories')}`
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={node.ring === 0 ? `${name} (centre)` : name}
      className="brain-map-node cursor-pointer outline-none"
      opacity={dim ? 0.4 : 1}
      onClick={onStep}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onStep()
        }
      }}
    >
      <title>{node.label}</title>
      {(node.ring === 0 || lit) && (
        <circle
          cx={node.x}
          cy={node.y}
          r={node.r + 4}
          fill="none"
          className={node.ring === 0 ? 'brain-map-halo' : 'brain-map-halo brain-map-halo--lit'}
        />
      )}
      <circle
        cx={node.x}
        cy={node.y}
        r={node.r}
        fill={`var(${GRAPH_COLORS[node.kind]})`}
        stroke="var(--px-bg)"
        strokeWidth={2}
      />
      {node.caption && (
        <text
          x={node.caption.x}
          y={node.caption.y}
          textAnchor={node.caption.anchor}
          className={
            node.ring === 0 ? 'brain-map-caption brain-map-caption--centre' : 'brain-map-caption'
          }
        >
          {node.caption.text}
        </text>
      )}
    </g>
  )
}

/** Arrowheads for single links: subject to object. */
export function MapDefs(): React.JSX.Element {
  return (
    <defs>
      {[
        ['brain-arrow', 'var(--px-border-strong)'],
        ['brain-arrow-lit', 'var(--px-accent)'],
      ].map(([id, fill]) => (
        <marker
          key={id}
          id={id}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill={fill} />
        </marker>
      ))}
    </defs>
  )
}
