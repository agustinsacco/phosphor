import { useCallback, useMemo, useRef, useState } from 'react'
import type { BrainGraph, BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { GRAPH_COLORS } from './graphColors'
import { graphModel, type GraphNode, type GraphLink } from './graphModel'
import { useGraphScene } from './useGraphScene'
import { useBrainResource } from './useBrainResource'
import { TooltipButton } from '@/components/Tooltip'

export function BrainGraph3D({
  graph,
  path = null,
  focus,
  matches = null,
  onFocus,
}: {
  graph: BrainGraph
  path?: BrainLink[] | null
  focus: string | null
  matches?: Set<string> | null
  onFocus: (id: string) => void
}): React.JSX.Element {
  const model = useMemo(() => graphModel(graph), [graph])
  const [dimensions, setDimensions] = useState<2 | 3>(3)
  const [edge, setEdge] = useState<GraphLink | null>(null)
  const pathMatches = useMemo(
    () => (path ? new Set(path.flatMap((link) => [link.subjectId, link.objectId])) : matches),
    [path, matches],
  )
  const pathIds = useMemo(() => (path ? new Set(path.map((link) => link.id)) : null), [path])
  const container = useRef<HTMLDivElement>(null)
  const { scene, unavailable } = useGraphScene(
    container,
    model,
    { focus, matches: pathMatches, path: pathIds },
    onFocus,
    setEdge,
    dimensions,
  )
  return (
    <section
      aria-label="Knowledge graph"
      className="border-border bg-bg-secondary/40 relative flex min-h-64 flex-1 flex-col rounded-lg border"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <GraphLegend nodes={model.nodes} />
        <div className="flex gap-1">
          <Button size="xs" aria-pressed={dimensions === 2} onClick={() => setDimensions(2)}>
            2D
          </Button>
          <Button size="xs" aria-pressed={dimensions === 3} onClick={() => setDimensions(3)}>
            3D
          </Button>
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
      {edge && <EdgeDetail key={edge.id} edge={edge} />}
      <GraphAccess nodes={model.nodes} focus={focus} matches={pathMatches} onFocus={onFocus} />
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
  const [keyboardFocus, setKeyboardFocus] = useState<string | null>(null)
  return (
    <>
      <ul className="sr-only" aria-label="Graph entities">
        {nodes.map((node) => (
          <li key={node.id}>
            <TooltipButton
              type="button"
              tooltip={false}
              aria-label={`Focus ${node.label}`}
              aria-pressed={focus === node.id}
              data-highlighted={!matches || matches.has(node.id)}
              onFocus={() => setKeyboardFocus(node.label)}
              onBlur={() => setKeyboardFocus(null)}
              onClick={() => onFocus(node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onFocus(node.id)
                }
              }}
            >
              {node.label}
            </TooltipButton>
          </li>
        ))}
      </ul>
      {keyboardFocus && (
        <span
          role="status"
          className="bg-bg-primary border-accent text-text-primary pointer-events-none absolute bottom-3 left-3 rounded-md border px-3 py-1 text-sm shadow"
        >
          Focus {keyboardFocus}
        </span>
      )}
    </>
  )
}

function EdgeDetail({ edge }: { edge: GraphLink }): React.JSX.Element {
  const load = useCallback(
    () => window.phosphor.invoke('brain:memory', edge.memoryId),
    [edge.memoryId],
  )
  const { data, error, retry } = useBrainResource(load)
  return (
    <div role="status" className="border-border bg-bg-secondary border-t p-3 text-sm">
      <p>{edge.predicates.map((p) => p.replaceAll('_', ' ')).join(', ')}</p>
      {data?.memory.summary || error || 'Loading supporting memory…'}
      {error && (
        <Button size="xs" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  )
}

function GraphLegend({ nodes }: { nodes: GraphNode[] }): React.JSX.Element {
  return (
    <div aria-label="Entity kinds" className="text-text-tertiary flex flex-wrap gap-3 text-sm">
      {[...new Set(nodes.map((node) => node.kind))].map((kind) => (
        <span key={kind} className="flex items-center gap-1">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: `var(${GRAPH_COLORS[kind]})` }}
          />
          {kind}
        </span>
      ))}
    </div>
  )
}
