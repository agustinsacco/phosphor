export interface Vec {
  x: number
  y: number
  z: number
}
export interface FitView {
  forward: Vec
  up: Vec
  /** Vertical field of view, in degrees. */
  fov: number
  aspect: number
  /** Pane height and padding, in pixels. */
  height: number
  padding: number
  /** Closest the camera may come to the centre, so a lone node is not magnified. */
  minDistance?: number
}

const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec, b: Vec): Vec => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const unit = (v: Vec): Vec => {
  const length = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}
const extent = (points: Vec[], axis: keyof Vec): number =>
  (Math.min(...points.map((p) => p[axis])) + Math.max(...points.map((p) => p[axis]))) / 2

/**
 * Where the camera must sit, along its current view direction, for every node
 * sphere to fit the pane. The library's zoomToFit fits the eight corners of the
 * 3D bounding box instead; a spread-out layout leaves those corners empty, so it
 * stops far too early and the graph fills a fraction of the pane.
 */
export function fitCamera(
  points: (Vec & { r: number })[],
  view: FitView,
): { position: Vec; lookAt: Vec } | null {
  if (!points.length) return null
  const forward = unit(view.forward)
  const right = unit(cross(forward, view.up))
  const up = unit(cross(right, forward))
  const fov = Math.max(1, (1 - (2 * view.padding) / Math.max(1, view.height)) * view.fov)
  const vertical = Math.tan((fov / 2) * (Math.PI / 180))
  const horizontal = vertical * view.aspect
  const center = { x: extent(points, 'x'), y: extent(points, 'y'), z: extent(points, 'z') }
  const distance = Math.max(
    view.minDistance ?? 0,
    ...points.map((point) => {
      const local = { x: point.x - center.x, y: point.y - center.y, z: point.z - center.z }
      const across = Math.max(
        (Math.abs(dot(local, up)) + point.r) / vertical,
        (Math.abs(dot(local, right)) + point.r) / horizontal,
      )
      return across - dot(local, forward)
    }),
  )
  return {
    position: {
      x: center.x - forward.x * distance,
      y: center.y - forward.y * distance,
      z: center.z - forward.z * distance,
    },
    lookAt: center,
  }
}
