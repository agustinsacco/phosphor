import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fitGraph, GRAPH_HEIGHT, GRAPH_WIDTH, type GraphNode, type View } from './graphLayout'
import { useReducedGraphMotion } from './useForceLayout'

export interface GraphSize {
  width: number
  height: number
}

export function useGraphSize(container: React.RefObject<HTMLDivElement | null>): GraphSize {
  const [size, setSize] = useState({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT })
  useLayoutEffect(() => {
    const element = container.current!
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect()
      if (width > 0 && height > 0)
        setSize((old) => (old.width === width && old.height === height ? old : { width, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [container])
  return size
}

export function useGraphViewport(
  nodes: GraphNode[],
  settled: boolean,
  focus: string | null,
  size: GraphSize,
): {
  view: View
  setView: React.Dispatch<React.SetStateAction<View>>
  fit: () => void
  cancelPan: () => void
} {
  const [view, setView] = useState(() => fitGraph(nodes, size.width, size.height))
  const fitted = useRef(false)
  const lastSize = useRef(size)
  const lastFocus = useRef<string | null>(null)
  const animation = useRef<number | null>(null)
  const reduced = useReducedGraphMotion()
  const cancelPan = useCallback(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current)
    animation.current = null
  }, [])
  useEffect(() => cancelPan, [cancelPan])
  useEffect(() => {
    if ((settled && nodes.length > 0 && !fitted.current) || lastSize.current !== size) {
      fitted.current = settled && nodes.length > 0
      lastSize.current = size
      cancelPan()
      const fit = fitGraph(nodes, size.width, size.height)
      const node = nodes.find((item) => item.id === focus)
      // This fit already centres the focus; the focus effect must not re-pan from the old scale.
      if (node) lastFocus.current = focus
      setView(
        node
          ? {
              ...fit,
              x: size.width / 2 - node.x * fit.scale,
              y: size.height / 2 - node.y * fit.scale,
            }
          : fit,
      )
    }
  }, [nodes, settled, size, focus, cancelPan])
  useEffect(() => {
    if (lastFocus.current === focus && !(reduced && animation.current !== null)) return
    const node = nodes.find((item) => item.id === focus)
    if (focus && !node) return
    lastFocus.current = focus
    cancelPan()
    if (!node) return
    const target = {
      ...view,
      x: size.width / 2 - node.x * view.scale,
      y: size.height / 2 - node.y * view.scale,
    }
    if (reduced) {
      setView(target)
      return
    }
    let start: number | undefined
    const pan = (time: number): void => {
      start ??= time
      const progress = Math.min(1, (time - start) / 300)
      const eased = progress * progress * (3 - 2 * progress)
      setView({
        ...target,
        x: view.x + (target.x - view.x) * eased,
        y: view.y + (target.y - view.y) * eased,
      })
      animation.current = progress < 1 ? requestAnimationFrame(pan) : null
    }
    animation.current = requestAnimationFrame(pan)
  }, [focus, nodes, view, size, reduced, cancelPan])
  return {
    view,
    setView,
    cancelPan,
    fit: () => {
      cancelPan()
      setView(fitGraph(nodes, size.width, size.height))
    },
  }
}
