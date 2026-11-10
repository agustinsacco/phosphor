import { describe, expect, it } from 'vitest'
import { fitCamera, type FitView } from './graphFit'

const view: FitView = {
  forward: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
  fov: 40,
  aspect: 1,
  height: 400,
  padding: 0,
}
const half = Math.tan((20 * Math.PI) / 180)

describe('fitCamera', () => {
  it('fits the nodes themselves, so empty bounding-box corners near the camera add no distance', () => {
    // The box spans z 0..100, but no node sits in its near corners.
    const points = [
      { x: -100, y: 0, z: 0, r: 0 },
      { x: 100, y: 0, z: 0, r: 0 },
      { x: 0, y: 0, z: 100, r: 0 },
    ]
    const fit = fitCamera(points, view)!
    expect(fit.lookAt).toEqual({ x: 0, y: 0, z: 50 })
    expect(fit.position.z).toBeCloseTo(100 / half)
    const boxCorner = 100 / half + 100
    expect(fit.position.z).toBeLessThan(boxCorner - 50)
  })

  it('keeps node radius and pane padding inside the view', () => {
    const points = [{ x: 50, y: 0, z: 0, r: 10 }]
    const bare = fitCamera(points, view)!
    const padded = fitCamera(points, { ...view, padding: 40 })!
    expect(bare.lookAt).toEqual({ x: 50, y: 0, z: 0 })
    expect(bare.position.z).toBeCloseTo(10 / half)
    expect(padded.position.z).toBeGreaterThan(bare.position.z)
  })

  it('never comes closer than the minimum distance, so a lone match is not magnified', () => {
    const fit = fitCamera([{ x: 0, y: 0, z: 0, r: 5 }], { ...view, minDistance: 250 })!
    expect(fit.position.z).toBeCloseTo(250)
  })

  it('uses the narrower horizontal angle in a tall pane and returns null for no nodes', () => {
    const points = [
      { x: -100, y: 0, z: 0, r: 0 },
      { x: 100, y: 0, z: 0, r: 0 },
    ]
    const wide = fitCamera(points, view)!
    const tall = fitCamera(points, { ...view, aspect: 0.5 })!
    expect(tall.position.z).toBeGreaterThan(wide.position.z)
    expect(fitCamera([], view)).toBeNull()
  })
})
