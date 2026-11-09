import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrainEntity } from '@shared/brain'
import {
  ALPHA_MIN,
  createSimulation,
  tickSimulation,
  type GraphEdge,
  type GraphNode,
  type Point,
  type Simulation,
} from './graphLayout'

export function useReducedGraphMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const change = (): void => setReduced(query?.matches ?? false)
    query?.addEventListener('change', change)
    return () => query?.removeEventListener('change', change)
  }, [])
  return reduced
}

export interface ForceLayout {
  nodes: GraphNode[]
  settled: boolean
  pin: (id: string, point: Point) => void
  release: (id: string) => void
}

/** Reduced motion settles off-screen in slices this long, so mount never blocks a frame. */
const SLICE_MS = 8
function settleSlice(simulation: Simulation): void {
  const end = performance.now() + SLICE_MS
  do tickSimulation(simulation)
  while (simulation.alpha > ALPHA_MIN && performance.now() < end)
}
const copy = (simulation: Simulation): GraphNode[] => simulation.nodes.map((node) => ({ ...node }))

export function useForceLayout(entities: BrainEntity[], edges: GraphEdge[]): ForceLayout {
  const reduced = useReducedGraphMotion()
  const [initial] = useState(() => {
    const simulation = createSimulation(entities, edges)
    if (reduced && simulation.alpha > ALPHA_MIN) settleSlice(simulation)
    return simulation
  })
  const simulation = useRef(initial)
  const data = useRef({ entities, edges })
  const [settled, setSettled] = useState(initial.alpha <= ALPHA_MIN)
  const [nodes, setNodes] = useState(() => (reduced && !settled ? [] : copy(initial)))
  const frame = useRef<number | null>(null)
  // Reduced motion shows only finished layouts: the last one stays until the next is done.
  const publish = useCallback(() => {
    const done = simulation.current.alpha <= ALPHA_MIN
    setSettled(done)
    if (done || !reduced) setNodes(copy(simulation.current))
  }, [reduced])
  const run = useCallback(() => {
    if (reduced && simulation.current.alpha > ALPHA_MIN) settleSlice(simulation.current)
    publish()
    if (simulation.current.alpha <= ALPHA_MIN || frame.current !== null) return
    const tick = (): void => {
      frame.current = null
      if (reduced) settleSlice(simulation.current)
      else tickSimulation(simulation.current)
      publish()
      if (simulation.current.alpha > ALPHA_MIN) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [publish, reduced])
  useEffect(() => {
    if (data.current.entities !== entities || data.current.edges !== edges) {
      simulation.current = createSimulation(entities, edges, simulation.current.nodes)
      data.current = { entities, edges }
    }
    run()
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [entities, edges, run])
  // Animated drags reheat so neighbours follow; reduced motion moves only the dragged node.
  const moved = (): void => {
    if (reduced) return publish()
    simulation.current.alpha = Math.max(simulation.current.alpha, 0.3)
    run()
  }
  const find = (id: string): GraphNode | undefined =>
    simulation.current.nodes.find((item) => item.id === id)
  return {
    nodes,
    settled,
    pin: (id, point) => {
      const node = find(id)
      if (!node) return
      node.x = node.fx = point.x
      node.y = node.fy = point.y
      node.vx = node.vy = 0
      moved()
    },
    release: (id) => {
      const node = find(id)
      if (!node) return
      delete node.fx
      delete node.fy
      moved()
    },
  }
}
