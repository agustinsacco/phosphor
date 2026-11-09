import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrainEntity } from '@shared/brain'
import {
  ALPHA_MIN,
  createSimulation,
  settleSimulation,
  tickSimulation,
  type GraphEdge,
  type GraphNode,
  type Point,
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

export function useForceLayout(entities: BrainEntity[], edges: GraphEdge[]): ForceLayout {
  const reduced = useReducedGraphMotion()
  const [initial] = useState(() => {
    const simulation = createSimulation(entities, edges)
    if (reduced) settleSimulation(simulation)
    return simulation
  })
  const simulation = useRef(initial)
  const data = useRef({ entities, edges })
  const [nodes, setNodes] = useState(() => initial.nodes.map((node) => ({ ...node })))
  const [settled, setSettled] = useState(initial.alpha <= ALPHA_MIN)
  const frame = useRef<number | null>(null)
  const publish = useCallback(() => {
    setNodes(simulation.current.nodes.map((node) => ({ ...node })))
    setSettled(simulation.current.alpha <= ALPHA_MIN)
  }, [])
  const run = useCallback(() => {
    if (reduced || simulation.current.alpha <= ALPHA_MIN) {
      settleSimulation(simulation.current)
      publish()
      return
    }
    if (frame.current !== null) return
    const tick = (): void => {
      frame.current = null
      tickSimulation(simulation.current)
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
    publish()
    run()
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [entities, edges, publish, run])
  const reheat = (): void => {
    simulation.current.alpha = Math.max(simulation.current.alpha, 0.3)
    publish()
    run()
  }
  return {
    nodes,
    settled,
    pin: (id, point) => {
      const node = simulation.current.nodes.find((item) => item.id === id)
      if (!node) return
      node.x = node.fx = point.x
      node.y = node.fy = point.y
      node.vx = node.vy = 0
      reheat()
    },
    release: (id) => {
      const node = simulation.current.nodes.find((item) => item.id === id)
      if (!node) return
      delete node.fx
      delete node.fy
      reheat()
    },
  }
}
