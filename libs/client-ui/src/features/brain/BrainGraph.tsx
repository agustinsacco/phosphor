import { useEffect, useState } from 'react'
import type { BrainGraph as Graph } from '@shared/brain'
import { Button } from '@/components/form'

export const MAX_BRAIN_NODES = 32
export const MAX_BRAIN_EDGES = 64

export function BrainGraph({
  graph,
  onEntity,
}: {
  graph: Graph
  onEntity: (id: string) => void
}): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden')
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const motion = (): void => setReduced(query.matches)
    const visibility = (): void => setHidden(document.visibilityState === 'hidden')
    query.addEventListener('change', motion)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      query.removeEventListener('change', motion)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  const nodes = graph.nodes.slice(0, MAX_BRAIN_NODES)
  return (
    <section aria-label="Memory relationships" className="brain-card">
      <h2>Relationships · project-wide</h2>
      <p>
        Adjacency is not causation. Connections are project-wide reviewed claims, not proof.
        Branch-local claims are excluded. Use the keyboard-accessible entity list below.
      </p>
      <Button aria-pressed={paused} onClick={() => setPaused(!paused)}>
        {paused ? 'Resume graph motion' : 'Pause graph motion'}
      </Button>
      <RelationshipDiagram graph={graph} paused={paused || hidden || reduced} />
      {(graph.truncated ||
        graph.nodes.length > MAX_BRAIN_NODES ||
        graph.edges.length > MAX_BRAIN_EDGES) && (
        <p role="status">
          Truncated graph: showing at most {MAX_BRAIN_NODES} entities and {MAX_BRAIN_EDGES}{' '}
          connections. Select an entity to narrow the view.
        </p>
      )}
      <ul aria-label="Entities">
        {nodes.map((n) => (
          <li key={n.id}>
            <Button aria-label={`Explore ${n.label}`} onClick={() => onEntity(n.id)}>
              {n.label} · {n.kind}
            </Button>
          </li>
        ))}
      </ul>
      {!nodes.length && <p>No reviewed entities yet.</p>}
    </section>
  )
}

function RelationshipDiagram({
  graph,
  paused,
}: {
  graph: Graph
  paused: boolean
}): React.JSX.Element {
  const nodes = graph.nodes.slice(0, MAX_BRAIN_NODES)
  const points = new Map(
    nodes.map((n, i) => {
      const angle = (i * Math.PI * 2) / nodes.length
      return [n.id, { x: 300 + 240 * Math.cos(angle), y: 160 + 120 * Math.sin(angle) }]
    }),
  )
  const edges = graph.edges
    .filter((e) => points.has(e.subjectId) && !!e.objectId && points.has(e.objectId))
    .slice(0, MAX_BRAIN_EDGES)
  return (
    <svg
      className="brain-graph"
      data-paused={String(paused)}
      viewBox="0 0 600 320"
      aria-hidden="true"
    >
      {edges.map((e) => {
        const a = points.get(e.subjectId)!
        const b = points.get(e.objectId!)!
        return (
          <line
            key={e.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="currentColor"
            opacity=".25"
          />
        )
      })}
      {nodes.map((n) => {
        const p = points.get(n.id)!
        return (
          <g key={n.id} className="brain-node">
            <circle cx={p.x} cy={p.y} r="5" fill="currentColor" />
            <text x={p.x} y={p.y + 17} textAnchor="middle" fill="currentColor" fontSize="11">
              {n.label.slice(0, 26)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
