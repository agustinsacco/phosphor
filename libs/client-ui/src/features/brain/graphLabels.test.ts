import { expect, it, vi } from 'vitest'
import { PerspectiveCamera, type Vector2, type WebGLRenderer } from 'three'
import { graphLabel } from './graphLabels'

vi.mock('three-spritetext', () => ({
  default: class {
    material = { sizeAttenuation: true }
    updateMatrixWorld = vi.fn()
    scale = {
      x: 20,
      y: 6,
      multiplyScalar(factor: number) {
        this.x *= factor
        this.y *= factor
        return this
      },
    }
    constructor(public text: string) {}
  },
}))

it('keeps labels at twelve CSS pixels across pane sizes and camera distances', () => {
  const label = graphLabel('Harbor', 12)
  const camera = new PerspectiveCamera(40, 2, 0.1, 10000)
  expect(label.material.sizeAttenuation).toBe(false)
  for (const height of [200, 600, 1200]) {
    for (const distance of [120, 250, 2000]) {
      camera.position.z = distance
      const renderer = { getSize: (size: Vector2) => size.set(800, height) } as WebGLRenderer
      label.onBeforeRender(
        renderer,
        undefined as never,
        camera,
        undefined as never,
        label.material,
        undefined as never,
      )
      expect((label.scale.y * camera.projectionMatrix.elements[5]! * height) / 2).toBeCloseTo(12)
      expect(label.scale.x / label.scale.y).toBeCloseTo(20 / 6)
    }
  }
})
