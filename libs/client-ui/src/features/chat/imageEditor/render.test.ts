import { describe, expect, it } from 'vitest'
import { contrastFor, drawScene, type ImageLookup } from './render'
import type { LayerImage, Scene } from './scene'

/** A 2D context that records which drawing calls were made, in order. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = []
  const target = { canvas: { width: 100, height: 50 } } as Record<string | symbol, unknown>
  const ctx = new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key]
      return (...args: unknown[]) => {
        calls.push(`${String(key)}${key === 'fillText' ? `:${String(args[0])}` : ''}`)
        return { width: 10 }
      }
    },
    set(obj, key, value) {
      obj[key] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const base: LayerImage = { id: 'base', data: 'B', mimeType: 'image/png', width: 100, height: 50 }
const decoded = {} as CanvasImageSource
const images: ImageLookup = (img) => (img.id === 'base' ? decoded : undefined)

describe('drawScene', () => {
  const scene: Scene = {
    base,
    shapes: [
      { kind: 'rect', id: 'r', color: '#ef4444', width: 3, x: 1, y: 1, w: 10, h: 10 },
      { kind: 'text', id: 't', color: '#ef4444', at: { x: 5, y: 5 }, text: 'fix\nthis', size: 12 },
      { kind: 'step', id: 's', color: '#ef4444', at: { x: 20, y: 20 }, n: 3, size: 8 },
    ],
  }

  it('paints the base first, then each shape in order', () => {
    const { ctx, calls } = recordingContext()
    drawScene(ctx, scene, images)
    const painted = calls.filter((c) => /^(drawImage|strokeRect|fillText)/.test(c))
    expect(painted).toEqual([
      'drawImage',
      'strokeRect',
      'fillText:fix',
      'fillText:this',
      'fillText:3',
    ])
  })

  it('skips the shape whose text is being edited in place', () => {
    const { ctx, calls } = recordingContext()
    drawScene(ctx, scene, images, 't')
    expect(calls.filter((c) => c.startsWith('fillText'))).toEqual(['fillText:3'])
  })
})

describe('contrastFor', () => {
  it('haloes dark ink in white and light ink in black', () => {
    expect(contrastFor('#ef4444')).toBe('#ffffff')
    expect(contrastFor('#111111')).toBe('#ffffff')
    expect(contrastFor('#ffffff')).toBe('#111111')
    expect(contrastFor('#f59e0b')).toBe('#111111')
  })
})
