/** Pan/zoom transform for the session tree canvas. */
export interface Transform {
  x: number
  y: number
  scale: number
}

export const MIN_SCALE = 0.25
export const MAX_SCALE = 2.5

/**
 * Apply a wheel zoom anchored at a cursor position, so the point under the
 * cursor stays put as the scale changes.
 *
 * `cx`/`cy` are cursor coordinates relative to the canvas element.
 */
export function zoomAtPoint(current: Transform, deltaY: number, cx: number, cy: number): Transform {
  const delta = -deltaY * 0.0015
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * (1 + delta)))
  const ratio = scale / current.scale
  return {
    scale,
    x: cx - (cx - current.x) * ratio,
    y: cy - (cy - current.y) * ratio,
  }
}

/** Translate a transform by a drag delta from its recorded origin. */
export function panBy(
  current: Transform,
  origin: { x: number; y: number },
  dx: number,
  dy: number,
): Transform {
  return { ...current, x: origin.x + dx, y: origin.y + dy }
}
