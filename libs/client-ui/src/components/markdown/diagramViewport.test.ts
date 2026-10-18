import { describe, expect, it } from 'vitest'
import { fitDiagram, zoomDiagram } from './diagramViewport'

const viewport = { width: 1200, height: 800 } as DOMRectReadOnly

describe('diagram viewport', () => {
  it('fits wide and tall diagrams with padding and enlarges small diagrams', () => {
    expect(fitDiagram(4000, 400, viewport)).toEqual({ scale: 1136 / 4000, x: 0, y: 0 })
    expect(fitDiagram(400, 4000, viewport).scale).toBe(736 / 4000)
    expect(fitDiagram(400, 200, viewport).scale).toBe(1136 / 400)
    expect(fitDiagram(10, 10, viewport).scale).toBe(4)
    expect(fitDiagram(100000, 100, viewport).scale).toBeLessThan(0.1)
  })

  it('keeps the cursor anchor fixed when zooming a panned diagram', () => {
    const view = { scale: 0.5, x: 100, y: -50 }
    const zoomed = zoomDiagram(view, 2, 300, 200)
    expect((300 - zoomed.x) / zoomed.scale).toBe((300 - view.x) / view.scale)
    expect((200 - zoomed.y) / zoomed.scale).toBe((200 - view.y) / view.scale)
    expect(zoomDiagram(zoomed, 0.5, 300, 200)).toEqual(view)
    expect(zoomDiagram({ scale: 1, x: 0, y: 0 }, 2)).toEqual({ scale: 2, x: 0, y: 0 })
  })
})
