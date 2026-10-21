import { test, expect, browserFixture } from './fixture'

test('production installation icons are opaque, full-bleed and safe under launcher masks', async ({
  page,
}) => {
  const stack = await browserFixture(true)
  try {
    await page.goto(stack.origin)
    const manifestResponse = await page.request.get(`${stack.origin}/manifest.webmanifest`)
    expect(manifestResponse.ok()).toBe(true)
    const manifest = (await manifestResponse.json()) as {
      icons: { src: string; purpose: string }[]
    }
    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable')
    expect(maskable).toHaveLength(2)
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
    expect(apple).toBeTruthy()
    for (const src of [...maskable.map((icon) => icon.src), apple!]) {
      const pixels = await page.evaluate(async (url) => {
        const image = new Image()
        image.src = url
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        let transparent = 0
        let brightOutsideSafeZone = 0
        let bright = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] !== 255) transparent++
          // The amber nucleus, orbit and head must survive even a circular mask
          // of radius 40% of the canvas (the maskable-icon guaranteed safe zone).
          if (data[i]! > 150) {
            bright++
            const x = (i / 4) % canvas.width
            const y = Math.floor(i / 4 / canvas.width)
            if (
              Math.hypot(x + 0.5 - canvas.width / 2, y + 0.5 - canvas.height / 2) >
              canvas.width * 0.4
            )
              brightOutsideSafeZone++
          }
        }
        const at = (x: number, y: number) =>
          Array.from(data.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4))
        return {
          transparent,
          brightOutsideSafeZone,
          bright,
          corners: [
            at(0, 0),
            at(canvas.width - 1, 0),
            at(0, canvas.height - 1),
            at(canvas.width - 1, canvas.height - 1),
          ],
        }
      }, src)
      expect(pixels.transparent, src).toBe(0)
      expect(pixels.brightOutsideSafeZone, src).toBe(0)
      expect(pixels.bright, src).toBeGreaterThan(100)
      expect(pixels.corners, src).toEqual(Array(4).fill([31, 28, 24, 255]))
    }
  } finally {
    await stack.close()
  }
})
