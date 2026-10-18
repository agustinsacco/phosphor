export interface DiagramView {
  scale: number
  x: number
  y: number
}

export function fitDiagram(width: number, height: number, viewport: DOMRectReadOnly): DiagramView {
  return {
    scale: Math.min(
      4,
      Math.max(1, viewport.width - 64) / width,
      Math.max(1, viewport.height - 64) / height,
    ),
    x: 0,
    y: 0,
  }
}

/** Keep the diagram point under the cursor stationary while zooming. */
export function zoomDiagram(view: DiagramView, scale: number, x = 0, y = 0): DiagramView {
  const ratio = scale / view.scale
  return { scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio }
}
