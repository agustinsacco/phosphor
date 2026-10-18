/**
 * The image annotator's model: a base image plus vector shapes on top of it.
 *
 * Everything is in IMAGE pixels, never screen pixels, so the flattened PNG is
 * exactly what the editor showed. Stroke widths and text sizes are scaled by
 * the on-screen zoom when a shape is created (see `ImageEditor`), which keeps
 * a "medium" line looking medium on a 3024px Retina screenshot.
 *
 * Pure on purpose: geometry, hit testing and history are unit-tested here, and
 * the canvas code in `render.ts` only draws what this module decides.
 */

export interface Pt {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A decodable image: the base, or one pasted on top of it. */
export interface LayerImage {
  id: string
  data: string
  mimeType: string
  width: number
  height: number
}

export type Shape =
  | ({ kind: 'rect' | 'ellipse'; id: string; color: string; width: number } & Box)
  | { kind: 'arrow'; id: string; color: string; width: number; from: Pt; to: Pt }
  | { kind: 'pen'; id: string; color: string; width: number; points: Pt[]; highlight: boolean }
  | { kind: 'text'; id: string; color: string; at: Pt; text: string; size: number }
  | { kind: 'step'; id: string; color: string; at: Pt; n: number; size: number }
  | ({ kind: 'image'; id: string; image: LayerImage } & Box)

export type TextShape = Extract<Shape, { kind: 'text' }>

export interface Scene {
  base: LayerImage
  shapes: Shape[]
}

/** Measures a text shape; the canvas supplies it, tests fake it. */
export type MeasureText = (shape: TextShape) => { w: number; h: number }

export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'from' | 'to'

export function normalizeBox(a: Pt, b: Pt, square = false): Box {
  let w = b.x - a.x
  let h = b.y - a.y
  if (square) {
    const side = Math.max(Math.abs(w), Math.abs(h))
    w = Math.sign(w || 1) * side
    h = Math.sign(h || 1) * side
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) }
}

/** Line height multiplier shared by the renderer and the measurer. */
export const TEXT_LINE_HEIGHT = 1.25

export function bounds(shape: Shape, measure: MeasureText): Box {
  switch (shape.kind) {
    case 'rect':
    case 'ellipse':
    case 'image':
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
    case 'arrow':
      return normalizeBox(shape.from, shape.to)
    case 'pen': {
      const xs = shape.points.map((p) => p.x)
      const ys = shape.points.map((p) => p.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
    case 'text': {
      const { w, h } = measure(shape)
      return { x: shape.at.x, y: shape.at.y, w, h }
    }
    case 'step':
      return {
        x: shape.at.x - shape.size,
        y: shape.at.y - shape.size,
        w: shape.size * 2,
        h: shape.size * 2,
      }
  }
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function inBox(p: Pt, b: Box, pad: number): boolean {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad
}

/** Where `p` sits relative to an ellipse: 1 on its outline, below 1 inside. */
function ellipseDistance(shape: Box, p: Pt, grow: number): number {
  const nx = (p.x - (shape.x + shape.w / 2)) / Math.max(shape.w / 2 + grow, 0.5)
  const ny = (p.y - (shape.y + shape.h / 2)) / Math.max(shape.h / 2 + grow, 0.5)
  return nx * nx + ny * ny
}

/**
 * Does `p` touch the ink of `shape`? Boxes and ellipses are outlines, so only
 * their stroke counts: an arrow drawn inside a box stays selectable after the
 * box is drawn over it. `tolerance` is in image pixels.
 */
export function hits(shape: Shape, p: Pt, tolerance: number, measure: MeasureText): boolean {
  switch (shape.kind) {
    case 'image':
    case 'text':
      return inBox(p, bounds(shape, measure), tolerance)
    case 'rect': {
      const reach = tolerance + shape.width / 2
      return inBox(p, shape, reach) && !inBox(p, shape, -reach)
    }
    case 'ellipse': {
      const reach = tolerance + shape.width / 2
      return ellipseDistance(shape, p, reach) <= 1 && ellipseDistance(shape, p, -reach) >= 1
    }
    case 'arrow':
      return distToSegment(p, shape.from, shape.to) <= tolerance + shape.width / 2
    case 'pen': {
      const reach = tolerance + shape.width / 2
      if (shape.points.length === 1)
        return Math.hypot(p.x - shape.points[0]!.x, p.y - shape.points[0]!.y) <= reach
      for (let i = 1; i < shape.points.length; i++) {
        if (distToSegment(p, shape.points[i - 1]!, shape.points[i]!) <= reach) return true
      }
      return false
    }
    case 'step':
      return Math.hypot(p.x - shape.at.x, p.y - shape.at.y) <= shape.size + tolerance
  }
}

function encloses(shape: Shape, p: Pt): boolean {
  if (shape.kind === 'rect') return inBox(p, shape, 0)
  if (shape.kind === 'ellipse') return ellipseDistance(shape, p, 0) <= 1
  return false
}

/**
 * Topmost shape under `p`, or null; later shapes paint over earlier ones. Ink
 * wins over the empty inside of a box, which still selects when nothing else
 * is there.
 */
export function hitTest(
  shapes: Shape[],
  p: Pt,
  tolerance: number,
  measure: MeasureText,
): Shape | null {
  return (
    shapes.findLast((s) => hits(s, p, tolerance, measure)) ??
    shapes.findLast((s) => encloses(s, p)) ??
    null
  )
}

/** Draggable handles: box corners, or the two ends of an arrow. */
export function handles(shape: Shape): { handle: Handle; at: Pt }[] {
  switch (shape.kind) {
    case 'rect':
    case 'ellipse':
    case 'image':
      return [
        { handle: 'nw', at: { x: shape.x, y: shape.y } },
        { handle: 'ne', at: { x: shape.x + shape.w, y: shape.y } },
        { handle: 'sw', at: { x: shape.x, y: shape.y + shape.h } },
        { handle: 'se', at: { x: shape.x + shape.w, y: shape.y + shape.h } },
      ]
    case 'arrow':
      return [
        { handle: 'from', at: shape.from },
        { handle: 'to', at: shape.to },
      ]
    default:
      return []
  }
}

export function translate(shape: Shape, dx: number, dy: number): Shape {
  const move = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy })
  switch (shape.kind) {
    case 'rect':
    case 'ellipse':
    case 'image':
      return { ...shape, x: shape.x + dx, y: shape.y + dy }
    case 'arrow':
      return { ...shape, from: move(shape.from), to: move(shape.to) }
    case 'pen':
      return { ...shape, points: shape.points.map(move) }
    case 'text':
    case 'step':
      return { ...shape, at: move(shape.at) }
  }
}

/**
 * Drag one handle to `p`. A box keeps its opposite corner fixed; a pasted
 * image keeps its aspect ratio so a screenshot is never squashed.
 */
export function dragHandle(shape: Shape, handle: Handle, p: Pt): Shape {
  if (shape.kind === 'arrow') {
    return handle === 'from' ? { ...shape, from: p } : handle === 'to' ? { ...shape, to: p } : shape
  }
  if (shape.kind !== 'rect' && shape.kind !== 'ellipse' && shape.kind !== 'image') return shape
  const fixed: Pt = {
    x: handle === 'nw' || handle === 'sw' ? shape.x + shape.w : shape.x,
    y: handle === 'nw' || handle === 'ne' ? shape.y + shape.h : shape.y,
  }
  let target = p
  if (shape.kind === 'image' && shape.w > 0 && shape.h > 0) {
    const ratio = shape.w / shape.h
    const w = Math.max(Math.abs(p.x - fixed.x), Math.abs(p.y - fixed.y) * ratio)
    target = {
      x: fixed.x + Math.sign(p.x - fixed.x || 1) * w,
      y: fixed.y + Math.sign(p.y - fixed.y || 1) * (w / ratio),
    }
  }
  return { ...shape, ...normalizeBox(fixed, target) }
}

/** Next number for a step marker: one past the highest already placed. */
export function nextStep(shapes: Shape[]): number {
  return shapes.reduce((max, s) => (s.kind === 'step' ? Math.max(max, s.n) : max), 0) + 1
}

/** A pasted image, centred and shrunk to at most 60% of the base. */
export function placeLayer(layer: LayerImage, base: LayerImage): Shape {
  const scale = Math.min(1, (base.width * 0.6) / layer.width, (base.height * 0.6) / layer.height)
  const w = layer.width * scale
  const h = layer.height * scale
  return {
    kind: 'image',
    id: newId(),
    image: layer,
    x: (base.width - w) / 2,
    y: (base.height - h) / 2,
    w,
    h,
  }
}

/** Is a just-drawn shape big enough to keep, or was it really a click? */
export function isDegenerate(shape: Shape, minSize: number): boolean {
  switch (shape.kind) {
    case 'rect':
    case 'ellipse':
      return shape.w < minSize && shape.h < minSize
    case 'arrow':
      return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < minSize
    default:
      return false
  }
}

/* ---------------------------------------------------------------- history */

export interface History {
  past: Scene[]
  present: Scene
  future: Scene[]
}

/** Enough to walk back a whole annotation session without hoarding images. */
const HISTORY_LIMIT = 100

export function initHistory(scene: Scene): History {
  return { past: [], present: scene, future: [] }
}

export function commit(history: History, scene: Scene): History {
  if (scene === history.present) return history
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: scene,
    future: [],
  }
}

export function undo(history: History): History {
  const previous = history.past.at(-1)
  if (!previous) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export function redo(history: History): History {
  const [next, ...rest] = history.future
  if (!next) return history
  return { past: [...history.past, history.present], present: next, future: rest }
}

export function addShape(scene: Scene, shape: Shape): Scene {
  return { ...scene, shapes: [...scene.shapes, shape] }
}

/** Replace one shape by id (or drop it when `next` is null). */
export function withShape(scene: Scene, id: string, next: Shape | null): Scene {
  const shapes = next
    ? scene.shapes.map((s) => (s.id === id ? next : s))
    : scene.shapes.filter((s) => s.id !== id)
  return { ...scene, shapes }
}

/** Base64 characters a scene keeps alive beyond its flattened output. */
export function sceneBytes(scene: Scene): number {
  return scene.shapes.reduce(
    (sum, s) => sum + (s.kind === 'image' ? s.image.data.length : 0),
    scene.base.data.length,
  )
}

/** Identity for shapes and decoded images; never persisted. */
export function newId(): string {
  return crypto.randomUUID()
}
