// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAttachments, type AttachmentsApi } from './useAttachments'
import type { PendingAttachment } from '../attachments'
let root: Root
let container: HTMLDivElement
let api: AttachmentsApi | undefined
let attachments: PendingAttachment[]
const change = vi.fn()
const reject = vi.fn()
function Harness({ remote = true }: { remote?: boolean }) {
  api = useAttachments({ remote, attachments, onChange: change, onReject: reject })
  return null
}
function pick(file: File) {
  if (!api) throw new Error('Missing hook')
  api.addFiles([file])
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  attachments = []
  change.mockReset()
  reject.mockReset()
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function file(size = 3, bytes = Promise.resolve(new TextEncoder().encode('abc').buffer)) {
  const file = new File(['abc'], 'a.pdf', { type: 'application/pdf' })
  Object.defineProperties(file, { size: { value: size }, arrayBuffer: { value: () => bytes } })
  return file
}
it.each(['unmount', 'capability-loss'] as const)(
  'does not resurrect remote bytes after %s',
  async (reason) => {
    let finish: (bytes: ArrayBuffer) => void = () => {}
    const bytes = new Promise<ArrayBuffer>((resolve) => {
      finish = resolve
    })
    await act(async () => root.render(<Harness />))
    act(() => pick(file(3, bytes)))
    if (reason === 'unmount') {
      act(() => root.unmount())
      root = createRoot(container)
    } else act(() => root.render(<Harness remote={false} />))
    await act(async () => finish(new TextEncoder().encode('abc').buffer))
    expect(change).not.toHaveBeenCalled()
  },
)
it('bounds picks before retaining bytes and reports a global-budget refusal without a partial append', async () => {
  await act(async () => root.render(<Harness />))
  await act(async () => pick(file(20 * 1024 * 1024 + 1)))
  expect(change).not.toHaveBeenCalled()
  expect(reject).toHaveBeenCalled()
  change.mockImplementationOnce(() => {
    throw new Error('budget')
  })
  await act(async () => pick(file()))
  expect(reject).toHaveBeenLastCalledWith(
    'Remote attachments are full. Send or remove files first.',
  )
  attachments = Array(10).fill({ kind: 'file', path: '', name: 'a.pdf', size: 3, data: 'YWJj' })
  await act(async () => root.render(<Harness />))
  change.mockClear()
  await act(async () => pick(file()))
  expect(change).not.toHaveBeenCalled()
})
/* A phone photo, as a browser hands it over: 4032×3024 and too big to send whole. */
function cameraPhoto() {
  const photo = new File(['full-size'], 'IMG_0001.jpg', { type: 'image/jpeg' })
  Object.defineProperty(photo, 'size', { value: 12 * 1024 * 1024 })
  return photo
}
function stubCanvas() {
  const drawn: [number, number][] = []
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 4032, height: 3024, close: () => {} })),
  )
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { drawImage: (...args: number[]) => drawn.push([args[3]!, args[4]!]) }
      }
      async convertToBlob({ type }: { type: string }) {
        return new Blob(['small'], { type })
      }
    },
  )
  return drawn
}
it('shrinks a Host-bound photo before it is read, so it fits a prompt frame', async () => {
  const drawn = stubCanvas()
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => pick(cameraPhoto()))
    expect(reject).not.toHaveBeenCalled()
    expect(drawn).toEqual([[2000, 1500]])
    expect(change).toHaveBeenCalledWith([
      { kind: 'image', data: btoa('small'), mimeType: 'image/jpeg', name: 'IMG_0001.jpg' },
    ])
  } finally {
    vi.unstubAllGlobals()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  }
})
it('sends a local session its image as it is', async () => {
  const drawn = stubCanvas()
  try {
    await act(async () => root.render(<Harness remote={false} />))
    const photo = new File(['full-size'], 'IMG_0001.jpg', { type: 'image/jpeg' })
    await act(async () => pick(photo))
    expect(drawn).toEqual([])
    expect(change).toHaveBeenCalledWith([expect.objectContaining({ data: btoa('full-size') })])
  } finally {
    vi.unstubAllGlobals()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  }
})
