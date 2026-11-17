import { useCallback, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { BRAIN_ENTITY_KINDS } from '@shared/brain'
import { Button, NeutralSegmented } from '@/components/form'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { useBrainResource } from '../useBrainResource'
import { useBoxSize } from '../useBoxSize'
import { GRAPH_COLORS } from '../graphColors'
import { ENTITY_LABELS, ENTITY_WORDS } from '../memoryLabels'
import { layoutMap, type MapEdge, type MapNode } from './mapLayout'

const MAP_FALLBACK = { width: 320, height: 360 }

export interface MapHighlight {
  /** A neighbour pointed at in the profile or on the map: its edge to the selection lights. */
  hover: string | null
  /** The entities one memory names: links among them light, the rest dims. */
  lit: string[] | null
}

/** The selection and its neighbours in 2D, fitted to its box, with words for every colour. */
export function BrainMap({
  entityId,
  label,
  hops,
  onHops,
  highlight,
  onHover,
  onVisit,
  onMore,
  onFull,
}: {
  entityId: string
  label: string
  hops: 1 | 2
  onHops: (hops: 1 | 2) => void
  highlight: MapHighlight
  onHover: (id: string | null) => void
  onVisit: (id: string, label: string) => void
  onMore: () => void
  onFull: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const { width, height } = useBoxSize(box, MAP_FALLBACK)
  const load = useCallback(
    () => window.phosphor.invoke('brain:neighbourhood', entityId, hops),
    [entityId, hops],
  )
  const { data, error, retry } = useBrainResource(load)
  const layout = useMemo(
    () =>
      data
        ? layoutMap({
            centerId: entityId,
            nodes: data.nodes,
            links: data.links,
            hops,
            width,
            height,
          })
        : null,
    [data, entityId, hops, width, height],
  )
  const kinds = BRAIN_ENTITY_KINDS.filter((kind) => layout?.nodes.some((n) => n.kind === kind))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate">
          <SectionLabel>Map · {label}</SectionLabel>
        </span>
        <NeutralSegmented
          value={String(hops) as '1' | '2'}
          onChange={(value) => onHops(Number(value) as 1 | 2)}
          options={[
            { id: '1', label: '1 step' },
            { id: '2', label: '2 steps' },
          ]}
        />
        <Button size="xs" onClick={onFull}>
          Full map
        </Button>
      </header>
      <div ref={box} className="relative min-h-40 flex-1 overflow-hidden">
        {!layout ? (
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
            nodes={layout.nodes}
            edges={layout.edges}
            width={width}
            height={height}
            label={label}
            highlight={highlight}
            onHover={onHover}
            onVisit={onVisit}
          />
        )}
        {!!layout?.hidden && (
          <Button size="xs" className="bg-surface absolute bottom-2 right-2" onClick={onMore}>
            +{layout.hidden} more
          </Button>
        )}
      </div>
      {kinds.length > 0 && (
        <ul
          aria-label="Legend"
          className="border-border text-text-tertiary flex flex-wrap gap-x-3 gap-y-1 border-t px-3 py-1.5 text-sm"
        >
          {kinds.map((kind) => (
            <li key={kind} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ background: `var(${GRAPH_COLORS[kind]})` }}
              />
              {ENTITY_LABELS[kind]}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function edgeLit(edge: MapEdge, highlight: MapHighlight): boolean {
  if (highlight.lit) return highlight.lit.includes(edge.from) && highlight.lit.includes(edge.to)
  return !!highlight.hover && [edge.from, edge.to].includes(highlight.hover)
}

function MapDrawing({
  nodes,
  edges,
  width,
  height,
  label,
  highlight,
  onHover,
  onVisit,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  width: number
  height: number
  label: string
  highlight: MapHighlight
  onHover: (id: string | null) => void
  onVisit: (id: string, label: string) => void
}): React.JSX.Element {
  const at = new Map(nodes.map((node) => [node.id, node]))
  return (
    <svg
      role="group"
      aria-label={`Map of ${label} and its neighbours`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
      onMouseLeave={() => onHover(null)}
    >
      {edges.map((edge) => {
        const a = at.get(edge.from)!,
          b = at.get(edge.to)!
        const lit = edgeLit(edge, highlight)
        return (
          <g key={edge.key}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={lit ? 'var(--px-accent)' : 'var(--px-border-strong)'}
              strokeWidth={lit ? 2 : 1}
            />
            {lit && (
              <text
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2 - 4}
                textAnchor="middle"
                fill="var(--px-text-secondary)"
                style={{ fontSize: 'var(--text-2xs)' }}
              >
                {edge.links.map((link) => link.predicate.replaceAll('_', ' ')).join(' · ')}
              </text>
            )}
          </g>
        )
      })}
      {nodes.map((node) => (
        <MapNodeMark
          key={node.id}
          node={node}
          dim={
            (!!highlight.lit && !highlight.lit.includes(node.id)) ||
            (node.ring === 2 && !highlight.hover)
          }
          onHover={onHover}
          onVisit={onVisit}
        />
      ))}
    </svg>
  )
}

function MapNodeMark({
  node,
  dim,
  onHover,
  onVisit,
}: {
  node: MapNode
  dim: boolean
  onHover: (id: string | null) => void
  onVisit: (id: string, label: string) => void
}): React.JSX.Element {
  const name = `${node.label}, ${ENTITY_WORDS[node.kind]}, ${formatCount(node.memories, 'memory', 'memories')}`
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={node.ring === 0 ? `${name} (selected)` : name}
      className={clsx(
        'cursor-pointer outline-none focus-visible:[&>circle]:stroke-[var(--px-accent)]',
      )}
      opacity={dim ? 0.45 : 1}
      onClick={() => onVisit(node.id, node.label)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onVisit(node.id, node.label)
        }
      }}
      onMouseEnter={() => onHover(node.ring ? node.id : null)}
      onFocus={() => onHover(node.ring ? node.id : null)}
      onBlur={() => onHover(null)}
    >
      <title>{node.label}</title>
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
          fill={node.ring === 0 ? 'var(--px-text)' : 'var(--px-text-secondary)'}
          fontWeight={node.ring === 0 ? 600 : 400}
          style={{ fontSize: 'var(--text-xs)', pointerEvents: 'none' }}
        >
          {node.caption.text}
        </text>
      )}
    </g>
  )
}
