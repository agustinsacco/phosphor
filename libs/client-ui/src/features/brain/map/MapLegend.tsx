import { BRAIN_ENTITY_KINDS } from '@shared/brain'
import { GRAPH_COLORS } from '../graphColors'
import { ENTITY_LABELS } from '../memoryLabels'
import type { MapNode } from '../explorer/mapLayout'

/** Words for every colour and line on the map, never colour alone. */
export function MapLegend({ nodes }: { nodes: MapNode[] }): React.JSX.Element | null {
  const kinds = BRAIN_ENTITY_KINDS.filter((kind) => nodes.some((n) => n.kind === kind))
  if (!kinds.length) return null
  return (
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
      <li className="flex items-center gap-1">
        <svg aria-hidden="true" width="18" height="6">
          <line x1="0" y1="3" x2="18" y2="3" className="brain-map-line" />
        </svg>
        now
      </li>
      <li className="flex items-center gap-1">
        <svg aria-hidden="true" width="18" height="6">
          <line x1="0" y1="3" x2="18" y2="3" className="brain-map-line" strokeDasharray="4 3" />
        </svg>
        ended
      </li>
      <li>Arrows read subject to object</li>
    </ul>
  )
}
