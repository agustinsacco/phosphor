import { expect, it, vi } from 'vitest'
import { PerspectiveCamera, Raycaster, Vector2, Vector3, type WebGLRenderer } from 'three'
import { graphLabel } from './graphLabels'

vi.mock('three-spritetext', async () => {
  const { Sprite } = await import('three')
  return {
    default: class extends Sprite {
      constructor(public text: string) {
        super()
        this.scale.set(20, 6, 1)
      }
    },
  }
})

it('updates the rendered world scale in the same frame as a resize or camera zoom', () => {
  const label = graphLabel('Harbor', 12)
  const camera = new PerspectiveCamera(40, 2, 0.1, 10000)
  const size = new Vector2(800, 400)
  const renderer = { getSize: (target: Vector2) => target.copy(size) } as WebGLRenderer
  for (const height of [400, 800]) {
    for (const zoom of [1, 2]) {
      size.y = height
      camera.zoom = zoom
      camera.updateProjectionMatrix()
      // Three updates the scene matrices before invoking onBeforeRender.
      label.updateMatrixWorld()
      label.onBeforeRender(
        renderer,
        undefined as never,
        camera,
        undefined as never,
        label.material,
        undefined as never,
      )
      const worldScale = new Vector3().setFromMatrixScale(label.matrixWorld)
      expect((worldScale.y * camera.projectionMatrix.elements[5]! * height) / 2).toBeCloseTo(12)
      expect(worldScale.x / worldScale.y).toBeCloseTo(20 / 6)
    }
  }
})

it('never takes pointer hits, so a label that was never drawn cannot capture the hover', () => {
  // A hidden label is never sized for the screen: without attenuation it would span the whole view.
  const label = graphLabel('Harbor', 12)
  label.visible = false
  label.updateMatrixWorld()
  const camera = new PerspectiveCamera(40, 2, 0.1, 10000)
  camera.position.z = 600
  camera.updateMatrixWorld()
  const raycaster = new Raycaster()
  for (const point of [new Vector2(0, 0), new Vector2(-1, 1), new Vector2(0.6, -0.4)]) {
    raycaster.setFromCamera(point, camera)
    expect(raycaster.intersectObject(label)).toEqual([])
  }
})
