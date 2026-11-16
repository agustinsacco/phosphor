// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  canWriteBrowserImage,
  readBrowserImage,
  writeBrowserImage,
} from './browser-image-clipboard'

const image = { data: btoa('png bytes'), mimeType: 'image/png' }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function clipboard() {
  const write = vi.fn(async (_items: ClipboardItem[]) => {})
  const read = vi.fn<() => Promise<ClipboardItem[]>>(async () => [])
  vi.stubGlobal('navigator', { clipboard: { write, read } })
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
    },
  )
  return { write, read }
}

it('writes PNG bytes as PNG without decoding', async () => {
  const { write } = clipboard()
  expect(canWriteBrowserImage()).toBe(true)
  await writeBrowserImage(image)
  const item = write.mock.calls[0]![0][0] as unknown as { data: Record<string, Promise<Blob>> }
  const blob = await item.data['image/png']!
  expect(blob.type).toBe('image/png')
  expect(await blob.text()).toBe('png bytes')
})

it.each(['image/jpeg', 'image/webp', 'image/gif'])(
  'converts %s to PNG and starts write in the gesture',
  async (mimeType) => {
    const { write } = clipboard()
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 20
        naturalHeight = 10
        src = ''
        async decode() {}
      },
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback,
      type,
    ) {
      expect(this.width).toBe(20)
      expect(this.height).toBe(10)
      callback(new Blob(['converted'], { type }))
    })
    const pending = writeBrowserImage({ ...image, mimeType })
    expect(write).toHaveBeenCalledOnce()
    await pending
    const item = write.mock.calls[0]![0][0] as unknown as { data: Record<string, Promise<Blob>> }
    const blob = await item.data['image/png']!
    expect(blob.type).toBe('image/png')
    expect(await blob.text()).toBe('converted')
    expect(drawImage).toHaveBeenCalledOnce()
  },
)

it('reads an image after skipping text, or returns null for no image', async () => {
  const { read } = clipboard()
  expect(await readBrowserImage()).toBeNull()
  read.mockResolvedValue([
    { types: ['text/plain'] } as unknown as ClipboardItem,
    {
      types: ['image/png'],
      getType: async () => new Blob(['png bytes']),
    } as unknown as ClipboardItem,
  ])
  expect(await readBrowserImage()).toEqual(image)
})

it('reports unsupported APIs instead of pretending a copy or read succeeded', async () => {
  vi.stubGlobal('navigator', {})
  expect(canWriteBrowserImage()).toBe(false)
  await expect(writeBrowserImage(image)).rejects.toThrow('This browser cannot copy images')
  await expect(readBrowserImage()).rejects.toThrow('This browser cannot read clipboard images')
})

it('reports browser permission refusals for copy and read', async () => {
  const { write, read } = clipboard()
  write.mockRejectedValue(new Error('Permission denied'))
  read.mockRejectedValue(new Error('Permission denied'))
  await expect(writeBrowserImage(image)).rejects.toThrow(
    'The browser could not copy the image: Permission denied',
  )
  await expect(readBrowserImage()).rejects.toThrow(
    'The browser could not read the clipboard: Permission denied',
  )
})
