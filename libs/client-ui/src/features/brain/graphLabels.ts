import { Vector2 } from 'three'
import SpriteText from 'three-spritetext'

/** Keep text readable even when a dense graph or a high-degree hub pushes the camera far out. */
export function graphLabel(text: string, pixels: number): SpriteText {
  const label = new SpriteText(text, 6)
  const size = new Vector2()
  label.material.sizeAttenuation = false
  // Text stays readable over a sphere that sits in front of it.
  label.material.depthTest = false
  label.renderOrder = 1
  // Nodes and links take the pointer. A hidden label is never sized, so it would span the view.
  label.raycast = () => {}
  label.onBeforeRender = (renderer, _scene, camera): void => {
    renderer.getSize(size)
    // With attenuation disabled, projected height is scale.y * projectionY * paneHeight / 2.
    const height = (2 * pixels) / (Math.max(1, size.y) * camera.projectionMatrix.elements[5]!)
    if (Number.isFinite(height) && height > 0) {
      label.scale.multiplyScalar(height / label.scale.y)
      // Three has already updated world matrices before this callback.
      label.updateMatrixWorld()
    }
  }
  return label
}
