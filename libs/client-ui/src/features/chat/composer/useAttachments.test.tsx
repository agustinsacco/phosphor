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
