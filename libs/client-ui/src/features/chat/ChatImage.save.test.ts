// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { saveChatImage } from './ChatImage'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/svg+xml', 'img'],
])('saves %s as original bytes in a non-renderable download', async (mimeType, extension) => {
  vi.useFakeTimers()
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:image-download')
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = createObjectURL
    },
  )
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  saveChatImage({ type: 'image', mimeType, data: btoa('original bytes') })
  expect(click).toHaveBeenCalledOnce()
  const anchor = click.mock.contexts[0] as HTMLAnchorElement
  expect(anchor.download).toBe(`image.${extension}`)
  expect(anchor.rel).toBe('noopener')
  const blob = createObjectURL.mock.calls[0]![0] as Blob
  expect(blob.type).toBe('application/octet-stream')
  expect(await blob.text()).toBe('original bytes')
})
