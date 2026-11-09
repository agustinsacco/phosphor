import { useMemo, useRef } from 'react'
import type { BrainEntity, BrainMemory } from '@shared/brain'
import { Button } from '@/components/form'
import { GRAPH_COLORS } from './graphColors'
import { graphModel, type GraphNode } from './graphModel'
import { useGraphScene } from './useGraphScene'

export function BrainGraph3D({
  entities,
  memories,
  focus,
  matches = null,
  onFocus,
}: {
  entities: BrainEntity[]
  memories: BrainMemory[]
  focus: string | null
  matches?: Set<string> | null
  onFocus: (id: string) => void
}): React.JSX.Element {
  const model = useMemo(() => graphModel(entities, memories), [entities, memories])
  const container = useRef<HTMLDivElement>(null)
  const { scene, unavailable } = useGraphScene(container, model, { focus, matches }, onFocus)
  const kinds = [...new Set(model.nodes.map((node) => node.kind))]
  return (
    <section
      aria-label="Knowledge graph"
      className="border-border bg-bg-secondary/40 flex min-h-64 flex-1 flex-col rounded-lg border"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <div aria-label="Entity kinds" className="text-text-tertiary flex flex-wrap gap-3 text-sm">
          {kinds.map((kind) => (
            <span key={kind} className="flex items-center gap-1">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: `var(${GRAPH_COLORS[kind]})` }}
              />
              {kind}
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          <Button
            size="xs"
            aria-label="Zoom out"
            disabled={!scene}
            onClick={() => scene?.zoom(1 / 1.2)}
          >
            −
          </Button>
          <Button size="xs" aria-label="Zoom in" disabled={!scene} onClick={() => scene?.zoom(1.2)}>
            +
          </Button>
          <Button size="xs" disabled={!scene} onClick={() => scene?.fit()}>
            Fit
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={container}
          aria-label="Memory relationships"
          className="absolute inset-0 touch-none"
        />
        {unavailable && (
          <p role="status" className="text-text-tertiary p-6 text-center text-sm">
            The 3D graph is unavailable here. You can still search and browse your memories.
          </p>
        )}
      </div>
      <GraphAccess nodes={model.nodes} focus={focus} matches={matches} onFocus={onFocus} />
    </section>
  )
}

function GraphAccess({
  nodes,
  focus,
  matches,
  onFocus,
}: {
  nodes: GraphNode[]
  focus: string | null
  matches: Set<string> | null
  onFocus: (id: string) => void
}): React.JSX.Element {
  return (
    <ul className="sr-only focus-within:not-sr-only focus-within:p-3" aria-label="Graph entities">
      {nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            role="button"
            aria-label={`Focus ${node.label}`}
            aria-pressed={focus === node.id}
            data-highlighted={!matches || matches.has(node.id)}
            onClick={() => onFocus(node.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onFocus(node.id)
              }
            }}
          >
            {node.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
