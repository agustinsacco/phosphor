import { describe, it, expect } from 'vitest'
import { zoomAtPoint, panBy, MIN_SCALE, MAX_SCALE, type Transform } from './panZoom'

const identity: Transform = { x: 0, y: 0, scale: 1 }

describe('zoomAtPoint', () => {
  it('zooms in on a negative deltaY (scroll up)', () => {
    expect(zoomAtPoint(identity, -100, 0, 0).scale).toBeGreaterThan(1)
  })

  it('zooms out on a positive deltaY (scroll down)', () => {
    expect(zoomAtPoint(identity, 100, 0, 0).scale).toBeLessThan(1)
  })

  it('clamps to the maximum scale', () => {
    const zoomed = zoomAtPoint({ x: 0, y: 0, scale: MAX_SCALE }, -100_000, 0, 0)
    expect(zoomed.scale).toBe(MAX_SCALE)
  })

  it('clamps to the minimum scale', () => {
    const zoomed = zoomAtPoint({ x: 0, y: 0, scale: MIN_SCALE }, 100_000, 0, 0)
    expect(zoomed.scale).toBe(MIN_SCALE)
  })

  it('keeps the point under the cursor fixed', () => {
    const before: Transform = { x: 40, y: 25, scale: 1 }
    const cx = 200
    const cy = 150
    // Canvas coordinate currently under the cursor.
    const worldX = (cx - before.x) / before.scale
    const worldY = (cy - before.y) / before.scale

    const after = zoomAtPoint(before, -120, cx, cy)

    // The same canvas coordinate must still project to the cursor.
    expect(after.x + worldX * after.scale).toBeCloseTo(cx, 6)
    expect(after.y + worldY * after.scale).toBeCloseTo(cy, 6)
  })

  it('keeps the cursor anchor when zooming out too', () => {
    const before: Transform = { x: -30, y: 60, scale: 1.8 }
    const cx = 90
    const cy = 210
    const worldX = (cx - before.x) / before.scale
    const worldY = (cy - before.y) / before.scale

    const after = zoomAtPoint(before, 200, cx, cy)

    expect(after.x + worldX * after.scale).toBeCloseTo(cx, 6)
    expect(after.y + worldY * after.scale).toBeCloseTo(cy, 6)
  })

  it('is a no-op for a zero delta', () => {
    expect(zoomAtPoint({ x: 10, y: 20, scale: 1.5 }, 0, 50, 50)).toEqual({
      x: 10,
      y: 20,
      scale: 1.5,
    })
  })

  it('does not move the origin when zooming at (0,0) with no offset', () => {
    const after = zoomAtPoint(identity, -100, 0, 0)
    expect(after.x).toBe(0)
    expect(after.y).toBe(0)
  })
})

describe('panBy', () => {
  it('translates from the drag origin', () => {
    expect(panBy(identity, { x: 100, y: 50 }, 25, -10)).toEqual({ x: 125, y: 40, scale: 1 })
  })

  it('preserves scale', () => {
    expect(panBy({ x: 0, y: 0, scale: 2 }, { x: 0, y: 0 }, 5, 5).scale).toBe(2)
  })

  it('is a no-op for a zero delta', () => {
    expect(panBy({ x: 7, y: 9, scale: 1 }, { x: 7, y: 9 }, 0, 0)).toEqual({
      x: 7,
      y: 9,
      scale: 1,
    })
  })
})
