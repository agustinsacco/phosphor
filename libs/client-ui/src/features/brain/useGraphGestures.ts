import { useEffect, useRef } from 'react'
import { svgPoint, worldPoint, zoomView, type Point, type View } from './graphLayout'
import type { ForceLayout } from './useForceLayout'
import type { GraphSize } from './useGraphViewport'

type SetView = React.Dispatch<React.SetStateAction<View>>
interface Drag {
  id: string | null
  start: Point
  origin: Point
  view: View
  moved: boolean
}

export function useGraphDrag(
  svg: React.RefObject<SVGSVGElement | null>,
  view: View,
  setView: SetView,
  layout: ForceLayout,
  size: GraphSize,
  onFocus: (id: string) => void,
  cancelPan: () => void,
): Pick<
  React.SVGProps<SVGSVGElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'
> {
  const drag = useRef<Drag | null>(null)
  const point = (event: { clientX: number; clientY: number }): Point =>
    svgPoint({ x: event.clientX, y: event.clientY }, svg.current!.getBoundingClientRect(), size)
  const release = (): void => {
    if (drag.current?.id) layout.release(drag.current.id)
    drag.current = null
  }
  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return
      cancelPan()
      const id = (event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null
      const node = layout.nodes.find((item) => item.id === id)
      drag.current = { id, start: point(event), origin: node ?? point(event), view, moved: false }
      if (node) layout.pin(node.id, node)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event) => {
      const current = drag.current
      if (!current) return
      const next = point(event)
      const dx = next.x - current.start.x,
        dy = next.y - current.start.y
      if (Math.hypot(dx, dy) > 3) current.moved = true
      if (!current.moved) return
      if (current.id) {
        const nextWorld = worldPoint(next, current.view)
        const startWorld = worldPoint(current.start, current.view)
        layout.pin(current.id, {
          x: current.origin.x + nextWorld.x - startWorld.x,
          y: current.origin.y + nextWorld.y - startWorld.y,
        })
      } else setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy })
    },
    onPointerUp: () => {
      const current = drag.current
      if (current?.id && !current.moved) onFocus(current.id)
      release()
    },
    onPointerCancel: release,
    onLostPointerCapture: release,
  }
}

export function useGraphWheel(
  svg: React.RefObject<SVGSVGElement | null>,
  setView: SetView,
  size: GraphSize,
  cancelPan: () => void,
): void {
  useEffect(() => {
    const element = svg.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      cancelPan()
      const anchor = svgPoint(
        { x: event.clientX, y: event.clientY },
        element.getBoundingClientRect(),
        size,
      )
      setView((previous) => zoomView(previous, Math.exp(-event.deltaY * 0.005), anchor))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [svg, setView, size, cancelPan])
}
