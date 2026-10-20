import { expect, it, vi } from 'vitest'
import { MODEL_IMAGE_EDGE, shrinkImage, type ImagePorts } from './shrinkImage'

const MB = 1024 * 1024
function photo(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type, lastModified: 7 })
  Object.defineProperty(file, 'size', { value: size })
  return file
}
/** A decoder that reports `width`×`height` and encodes to `encoded` bytes. */
function ports(width: number, height: number, encoded = 200_000) {
  const close = vi.fn()
  const render = vi.fn(async (_w: number, _h: number, type: string) => {
    return new Blob([new Uint8Array(encoded)], { type })
  })
  const decode = vi.fn<ImagePorts['decode']>(async () => ({ width, height, render, close }))
  return { decode, render, close }
}

it('fits a phone photo into the square pi resizes every image to', async () => {
  expect(MODEL_IMAGE_EDGE).toBe(2000)
  const p = ports(4032, 3024)
  const shrunk = await shrinkImage(photo('IMG_0001.jpg', 'image/jpeg', 5 * MB), p)
  expect(p.render).toHaveBeenCalledWith(2000, 1500, 'image/jpeg', 0.85)
  expect(shrunk).toMatchObject({ name: 'IMG_0001.jpg', type: 'image/jpeg', size: 200_000 })
  expect(p.close).toHaveBeenCalled()
})

it('keeps the shape of a tall screenshot and its PNG type', async () => {
  const p = ports(1179, 2556)
  const shrunk = await shrinkImage(photo('Screenshot.png', 'image/png', 2 * MB), p)
  expect(p.render).toHaveBeenCalledWith(923, 2000, 'image/png', 0.85)
  expect(shrunk.type).toBe('image/png')
})

it('sends an image that already fits as it is', async () => {
  for (const [type, size] of [
    ['image/jpeg', 400_000],
    // A PNG within the edge would only be re-encoded to about the same size.
    ['image/png', 3 * MB],
  ] as const) {
    const p = ports(1600, 1200)
    const file = photo('fits', type, size)
    expect(await shrinkImage(file, p)).toBe(file)
    expect(p.render).not.toHaveBeenCalled()
    expect(p.close).toHaveBeenCalled()
  }
})

it('re-encodes a heavy JPEG that already fits', async () => {
  const p = ports(1800, 1200)
  await shrinkImage(photo('heavy.jpg', 'image/jpeg', 4 * MB), p)
  expect(p.render).toHaveBeenCalledWith(1800, 1200, 'image/jpeg', 0.85)
})

it('leaves a GIF alone: redrawing it would drop every frame but the first', async () => {
  const p = ports(4000, 3000)
  const gif = photo('loop.gif', 'image/gif', 6 * MB)
  expect(await shrinkImage(gif, p)).toBe(gif)
  expect(p.decode).not.toHaveBeenCalled()
})

it('falls back to the original whenever shrinking cannot help', async () => {
  const file = photo('IMG_0002.jpg', 'image/jpeg', 5 * MB)
  const undecodable = ports(0, 0)
  undecodable.decode.mockResolvedValue(null)
  expect(await shrinkImage(file, undecodable)).toBe(file)
  const failing = ports(4032, 3024)
  failing.decode.mockRejectedValue(new Error('unsupported'))
  expect(await shrinkImage(file, failing)).toBe(file)
  const throwing = ports(4032, 3024)
  throwing.render.mockRejectedValue(new Error('no canvas'))
  expect(await shrinkImage(file, throwing)).toBe(file)
  expect(throwing.close).toHaveBeenCalled()
  const larger = ports(4032, 3024, 6 * MB)
  expect(await shrinkImage(file, larger)).toBe(file)
})
