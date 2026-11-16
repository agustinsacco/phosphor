import type { ForceGraph3DInstance } from '3d-force-graph'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { GraphNode, GraphLink } from './graphModel'

export type BrainForceGraph = ForceGraph3DInstance<GraphNode, GraphLink>

export interface GraphActivity {
  /** The library raycasts every frame from its last, or default, position: trust a real pointer. */
  inside: () => boolean
  wake: (duration?: number) => void
  reheat: () => void
  cooled: () => void
  dispose: () => void
}

function listen(target: EventTarget, handlers: Record<string, () => void>): () => void {
  for (const [type, handler] of Object.entries(handlers))
    target.addEventListener(type, handler, { passive: true })
  return () => {
    for (const [type, handler] of Object.entries(handlers))
      target.removeEventListener(type, handler)
  }
}

/** Keep raycasting responsive on input, but stop WebGL frames after cooling and camera motion. */
export function graphActivity(
  graph: BrainForceGraph,
  container: HTMLElement,
  onInteraction: () => void,
  onLeave: () => void = () => {},
): GraphActivity {
  let cooling = true
  let held = false
  let resuming = false
  let inside = false
  let until = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = (): void => {
    clearTimeout(timer)
    if (cooling || held) return
    const remaining = until - performance.now()
    if (remaining > 0) timer = setTimeout(check, remaining + 16)
    else graph.pauseAnimation()
  }
  const wake = (duration = 180): void => {
    until = Math.max(until, performance.now() + duration)
    // resumeAnimation renders synchronously; onEngineStop can wake us inside that frame.
    if (!resuming) {
      resuming = true
      graph.resumeAnimation()
      resuming = false
    }
    check()
  }
  const start = (): void => {
    onInteraction()
    held = true
    wake()
  }
  const end = (): void => {
    held = false
    wake()
  }
  const move = (): void => wake()
  const enter = (): void => {
    inside = true
    wake()
  }
  const leave = (): void => {
    inside = false
    onLeave()
    wake()
  }
  // Orbit controls without damping have no hidden inertia after pointer release.
  const controls = graph.controls() as OrbitControls
  controls.enableDamping = false
  controls.addEventListener('start', start)
  controls.addEventListener('end', end)
  controls.addEventListener('change', move)
  const unlisten = [
    listen(container, { pointerdown: start, pointerenter: enter, pointermove: enter }),
    listen(container, { pointerleave: leave, wheel: move }),
    listen(window, { pointerup: end, pointercancel: end }),
  ]
  return {
    inside: () => inside,
    wake,
    reheat: () => {
      cooling = true
      wake()
    },
    cooled: () => {
      cooling = false
      wake()
    },
    dispose: () => {
      clearTimeout(timer)
      controls.removeEventListener('start', start)
      controls.removeEventListener('end', end)
      controls.removeEventListener('change', move)
      for (const stop of unlisten) stop()
    },
  }
}
