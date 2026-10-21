import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicDir = resolve(import.meta.dirname, 'public')
const manifest = JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8')) as {
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}

function expectPngSize(src: string, size: number) {
  const png = readFileSync(resolve(publicDir, src.replace(/^\//, '')))
  expect(png.subarray(1, 4).toString()).toBe('PNG')
  expect(png.readUInt32BE(16)).toBe(size)
  expect(png.readUInt32BE(20)).toBe(size)
}

describe('PWA installation icons', () => {
  it('offers dedicated maskable icons without changing regular icon purposes', () => {
    for (const purpose of ['any', 'maskable']) {
      const icons = manifest.icons.filter((icon) => icon.purpose === purpose)
      expect(icons.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512'])
      for (const icon of icons) {
        expect(icon.type).toBe('image/png')
        expectPngSize(icon.src, Number(icon.sizes.split('x')[0]))
      }
    }
    const regularSources = manifest.icons.filter((icon) => icon.purpose === 'any').map((i) => i.src)
    for (const icon of manifest.icons.filter((icon) => icon.purpose === 'maskable'))
      expect(regularSources).not.toContain(icon.src)
  })

  it('uses a dedicated 180px Apple touch icon rather than a transparent favicon', () => {
    const html = readFileSync(resolve(import.meta.dirname, 'index.html'), 'utf8')
    const link = html.match(/<link rel="apple-touch-icon"[^>]+>/)?.[0]
    expect(link).toContain('sizes="180x180"')
    const src = link?.match(/href="([^"]+)"/)?.[1]
    expect(src).toBe('/icons/apple-touch-icon.png')
    expectPngSize(src!, 180)
  })
})
