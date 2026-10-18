import { bytesToBase64 } from '@/lib/base64'
import {
  TEXT_LINE_HEIGHT,
  bounds,
  handles,
  type LayerImage,
  type MeasureText,
  type Scene,
  type Shape,
  type TextShape,
} from './scene'

/**
 * Canvas drawing for the annotator. The same `drawScene` paints the editor
 * and the flattened PNG, so what the user saw is what the model receives.
 */

/** Looks up a decoded image; undefined while it is still decoding. */
export type ImageLookup = (image: LayerImage) => CanvasImageSource | undefined

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'

export function textFont(size: number): string {
  return `600 ${size}px ${FONT_FAMILY}`
}

/** Dark ink gets a light halo and vice versa, so text reads on any screenshot. */
export function contrastFor(color: string): string {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return '#ffffff'
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return luminance > 0.6 ? '#111111' : '#ffffff'
}

export function measureWith(ctx: CanvasRenderingContext2D): MeasureText {
  return (shape: TextShape) => {
    ctx.save()
    ctx.font = textFont(shape.size)
    const lines = shape.text.split('\n')
    const w = Math.max(...lines.map((line) => ctx.measureText(line).width), shape.size * 0.5)
    ctx.restore()
    return { w, h: lines.length * shape.size * TEXT_LINE_HEIGHT }
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, shape: Extract<Shape, { kind: 'arrow' }>): void {
  const { from, to, width } = shape
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  const head = Math.min(Math.max(width * 4, 12), length)
  const spread = Math.PI / 7
  // Stop the shaft at the head's base, or a thick line pokes past the tip.
  const base = { x: to.x - Math.cos(angle) * head * 0.8, y: to.y - Math.sin(angle) * head * 0.8 }
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(base.x, base.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - head * Math.cos(angle - spread), to.y - head * Math.sin(angle - spread))
  ctx.lineTo(to.x - head * Math.cos(angle + spread), to.y - head * Math.sin(angle + spread))
  ctx.closePath()
  ctx.fill()
}

function drawText(ctx: CanvasRenderingContext2D, shape: TextShape): void {
  ctx.font = textFont(shape.size)
  ctx.textBaseline = 'top'
  ctx.lineWidth = Math.max(2, shape.size * 0.2)
  ctx.strokeStyle = contrastFor(shape.color)
  shape.text.split('\n').forEach((line, i) => {
    const y = shape.at.y + i * shape.size * TEXT_LINE_HEIGHT
    ctx.strokeText(line, shape.at.x, y)
    ctx.fillText(line, shape.at.x, y)
  })
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, images: ImageLookup): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (shape.kind !== 'image') {
    ctx.strokeStyle = shape.color
    ctx.fillStyle = shape.color
  }
  switch (shape.kind) {
    case 'rect':
      ctx.lineWidth = shape.width
      ctx.strokeRect(shape.x, shape.y, shape.w, shape.h)
      break
    case 'ellipse':
      ctx.lineWidth = shape.width
      ctx.beginPath()
      ctx.ellipse(
        shape.x + shape.w / 2,
        shape.y + shape.h / 2,
        shape.w / 2,
        shape.h / 2,
        0,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
      break
    case 'arrow':
      ctx.lineWidth = shape.width
      drawArrow(ctx, shape)
      break
    case 'pen': {
      ctx.lineWidth = shape.width
      if (shape.highlight) ctx.globalAlpha = 0.35
      const [first, ...rest] = shape.points
      if (!first) break
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      // A single click still leaves a dot.
      if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y)
      for (const p of rest) ctx.lineTo(p.x, p.y)
      ctx.stroke()
      break
    }
    case 'text':
      drawText(ctx, shape)
      break
    case 'step':
      ctx.beginPath()
      ctx.arc(shape.at.x, shape.at.y, shape.size, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = Math.max(1.5, shape.size * 0.12)
      ctx.strokeStyle = contrastFor(shape.color)
      ctx.stroke()
      ctx.fillStyle = contrastFor(shape.color)
      ctx.font = textFont(shape.size * 1.1)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(shape.n), shape.at.x, shape.at.y + shape.size * 0.06)
      break
    case 'image': {
      const source = images(shape.image)
      if (source) ctx.drawImage(source, shape.x, shape.y, shape.w, shape.h)
      break
    }
  }
  ctx.restore()
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  images: ImageLookup,
  hideId?: string,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const base = images(scene.base)
  if (base) ctx.drawImage(base, 0, 0, scene.base.width, scene.base.height)
  for (const shape of scene.shapes) {
    if (shape.id !== hideId) drawShape(ctx, shape, images)
  }
}

/** Handle radius in screen pixels. */
export const HANDLE_RADIUS = 5

/** Dashed outline plus handles; editor only, never flattened. */
export function drawSelection(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  unit: number,
  measure: MeasureText,
): void {
  const box = bounds(shape, measure)
  const pad = 4 * unit
  ctx.save()
  ctx.lineWidth = 1.5 * unit
  ctx.setLineDash([5 * unit, 4 * unit])
  ctx.strokeStyle = '#3b82f6'
  ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2)
  ctx.setLineDash([])
  ctx.fillStyle = '#ffffff'
  for (const { at } of handles(shape)) {
    ctx.beginPath()
    ctx.arc(at.x, at.y, HANDLE_RADIUS * unit, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

/** Paint the scene at full resolution and return it as base64 PNG. */
export async function flattenScene(scene: Scene, images: ImageLookup): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = scene.base.width
  canvas.height = scene.base.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')
  drawScene(ctx, scene, images)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))),
      'image/png',
    ),
  )
  return bytesToBase64(await blob.arrayBuffer())
}

/** Decode base64 image data into something the canvas can draw. */
export async function decodeImage(
  data: string,
  mimeType: string,
): Promise<{ element: HTMLImageElement; width: number; height: number }> {
  const element = new Image()
  element.src = `data:${mimeType};base64,${data}`
  await element.decode()
  return { element, width: element.naturalWidth, height: element.naturalHeight }
}
