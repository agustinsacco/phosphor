import type { ForceGraph3DInstance } from '3d-force-graph'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { GraphNode, GraphLink } from './graphModel'

export type BrainForceGraph = ForceGraph3DInstance<GraphNode, GraphLink>

/** Keep raycasting responsive on input, but stop WebGL frames after cooling and camera motion. */
export function graphActivity(
  graph: BrainForceGraph,
  container: HTMLElement,
): {
  wake: (duration?: number) => void
  reheat: () => void
  cooled: () => void
  dispose: () => void
} {
  let cooling = true
  let held = false
  let resuming = false
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
    held = true
    wake()
  }
  const end = (): void => {
    held = false
    wake()
  }
  const move = (): void => wake()
  // Orbit controls without damping have no hidden inertia after pointer release.
  const controls = graph.controls() as OrbitControls
  controls.enableDamping = false
  controls.addEventListener('start', start)
  controls.addEventListener('end', end)
  controls.addEventListener('change', move)
  container.addEventListener('pointerdown', start)
  container.addEventListener('pointermove', move)
  container.addEventListener('pointerleave', move)
  container.addEventListener('wheel', move, { passive: true })
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  return {
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
      container.removeEventListener('pointerdown', start)
      container.removeEventListener('pointermove', move)
      container.removeEventListener('pointerleave', move)
      container.removeEventListener('wheel', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    },
  }
}
