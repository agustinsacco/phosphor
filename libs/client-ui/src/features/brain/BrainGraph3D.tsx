import { useCallback, useMemo, useRef, useState } from 'react'
import type { BrainGraph, BrainLink } from '@shared/brain'
import { Button, NeutralSegmented } from '@/components/form'
import './explorer/knowledge.css'
import { ENTITY_LABELS } from './memoryLabels'
import { GRAPH_COLORS } from './graphColors'
import { graphModel, graphNeighbors, type GraphNode, type GraphLink } from './graphModel'
import type { GraphScene } from './graphScene'
import { useGraphScene } from './useGraphScene'
import { useBrainResource } from './useBrainResource'
import { TooltipButton } from '@/components/Tooltip'

export function BrainGraph3D({
  graph,
  path = null,
  focus,
  scope = 'all',
  selectionPending = false,
  matches = null,
  onFocus,
  onClear,
  toolbar,
  renderEdge,
}: {
  graph: BrainGraph
  path?: BrainLink[] | null
  focus: string | null
  scope?: 'all' | 'near'
  selectionPending?: boolean
  matches?: Set<string> | null
  onFocus: (id: string) => void
  onClear?: () => void
  toolbar?: React.ReactNode
  renderEdge?: (edge: GraphLink) => React.ReactNode
}): React.JSX.Element {
  const model = useMemo(() => graphModel(graph), [graph])
  const [dimensions, setDimensions] = useState<2 | 3>(3)
  const [edge, setEdge] = useState<GraphLink | null>(null)
  const pathMatches = useMemo(
    () =>
      path?.length
        ? new Set([...(matches ?? []), ...path.flatMap((link) => [link.subjectId, link.objectId])])
        : matches,
    [path, matches],
  )
  const pathIds = useMemo(() => (path ? new Set(path.map((link) => link.id)) : null), [path])
  const container = useRef<HTMLDivElement>(null)
  const { scene, unavailable } = useGraphScene(
    container,
    model,
    { focus, matches: pathMatches, path: pathIds, scope },
    onFocus,
    setEdge,
    dimensions,
    onClear,
    selectionPending,
  )
  return (
    <section
      aria-label="Knowledge graph"
      className="bg-bg-secondary/40 relative flex min-h-64 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        {toolbar}
        <GraphControls dimensions={dimensions} setDimensions={setDimensions} scene={scene} />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={container}
          aria-label="Memory relationships"
          className="absolute inset-0 touch-none"
        />
        <GraphAccess
          nodes={model.nodes}
          focus={focus}
          matches={pathMatches ?? (focus ? graphNeighbors(model, focus) : null)}
          onFocus={onFocus}
        />
        {unavailable && (
          <p role="status" className="text-text-tertiary p-6 text-center text-sm">
            The 3D graph is unavailable here. You can still search and browse your memories.
          </p>
        )}
      </div>
      {edge && (renderEdge ? renderEdge(edge) : <EdgeDetail key={edge.id} edge={edge} />)}
      <div className="border-border border-t p-3">
        <GraphLegend nodes={model.nodes} />
      </div>
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
      <p className="font-medium">{edge.sentences.join('; ')}</p>
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
          {ENTITY_LABELS[kind]}
        </span>
      ))}
    </div>
  )
}

function GraphControls({
  dimensions,
  setDimensions,
  scene,
}: {
  dimensions: 2 | 3
  setDimensions: (value: 2 | 3) => void
  scene: GraphScene | null
}): React.JSX.Element {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-1">
      <NeutralSegmented
        value={String(dimensions)}
        options={[
          { id: '2', label: '2D' },
          { id: '3', label: '3D' },
        ]}
        onChange={(value) => setDimensions(Number(value) as 2 | 3)}
      />
      <TooltipButton
        aria-label="Zoom out"
        disabled={!scene}
        className="graph-icon"
        onClick={() => scene?.zoom(1 / 1.2)}
      >
        −
      </TooltipButton>
      <TooltipButton
        aria-label="Zoom in"
        disabled={!scene}
        className="graph-icon"
        onClick={() => scene?.zoom(1.2)}
      >
        +
      </TooltipButton>
      <TooltipButton
        aria-label="Fit the graph"
        tooltip="Fit the graph"
        disabled={!scene}
        className="graph-icon"
        onClick={() => scene?.fit()}
      >
        ⤢
      </TooltipButton>
    </div>
  )
}
