// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FILE_BYTES_ERRORS } from '@shared/host-protocol-file-bytes'
import type { FileDownloadProgress } from '@shared/ipc'
import { DownloadsBar } from '@/features/files/DownloadsBar'
import { useDownloadsStore } from './downloads'

const invoke = vi.fn()
let progress: (p: FileDownloadProgress) => void = () => undefined
const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    platform: 'darwin',
    invoke,
    onFileDownloadProgress: (listener: typeof progress) => {
      progress = listener
      return () => undefined
    },
  })
  invoke.mockImplementation((channel: string, request: { id: string } | string) => {
    if (channel === 'hosts:fileDownloadCancel') {
      pending
        .get(request as string)
        ?.reject(
          new Error(`Error invoking remote method 'x': Error: ${FILE_BYTES_ERRORS.cancelled}`),
        )
      return Promise.resolve()
    }
    if (channel !== 'hosts:fileDownload') return Promise.resolve()
    return new Promise((resolve, reject) =>
      pending.set((request as { id: string }).id, { resolve, reject }),
    )
  })
})
afterEach(() => {
  useDownloadsStore.setState({ items: [] })
  pending.clear()
  invoke.mockReset()
  vi.unstubAllGlobals()
})

const items = () => useDownloadsStore.getState().items
const settle = () => new Promise((r) => setTimeout(r, 0))

it('records progress, then where the file landed', async () => {
  const done = useDownloadsStore.getState().start('remote-1', 'renders/clip.mp4')
  expect(invoke).toHaveBeenCalledWith('hosts:fileDownload', {
    sessionId: 'remote-1',
    path: 'renders/clip.mp4',
    id: items()[0]!.id,
  })
  const { id } = items()[0]!
  progress({ id, received: 5, size: 10 })
  expect(items()[0]).toMatchObject({ name: 'clip.mp4', received: 5, size: 10, status: 'running' })
  pending.get(id)!.resolve({ savedTo: '/Users/me/Downloads/clip.mp4' })
  await done
  expect(items()[0]).toMatchObject({ status: 'done', savedTo: '/Users/me/Downloads/clip.mp4' })
})

it('ignores a second ask for a file already downloading, and forgets a cancelled one', async () => {
  const done = useDownloadsStore.getState().start('remote-1', 'clip.mp4')
  await useDownloadsStore.getState().start('remote-1', 'clip.mp4')
  expect(items()).toHaveLength(1)
  useDownloadsStore.getState().cancel(items()[0]!.id)
  await done
  expect(items()).toEqual([])
})

it('keeps a failure’s fixed text without the IPC prefix', async () => {
  const done = useDownloadsStore.getState().start('remote-1', 'big.mov')
  pending
    .get(items()[0]!.id)!
    .reject(new Error(`Error invoking remote method 'x': Error: ${FILE_BYTES_ERRORS.tooLarge}`))
  await done
  expect(items()[0]).toMatchObject({ status: 'failed', error: FILE_BYTES_ERRORS.tooLarge })
})

it('keeps the three latest finished rows as new downloads start', async () => {
  for (const name of ['a', 'b', 'c', 'd']) {
    const done = useDownloadsStore.getState().start('remote-1', name)
    pending.get(items().at(-1)!.id)!.resolve({ savedTo: `/d/${name}` })
    await done
  }
  void useDownloadsStore.getState().start('remote-1', 'e')
  await settle()
  expect(items().map((d) => d.name)).toEqual(['c', 'd', 'e'])
})

it('shows a running download with Cancel, and a finished one with its folder', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  void useDownloadsStore.getState().start('remote-1', 'clip.mp4')
  progress({ id: items()[0]!.id, received: 1024 * 1024, size: 4 * 1024 * 1024 })
  await act(async () => root.render(<DownloadsBar />))
  expect(container.textContent).toContain('1.0 MB of 4.0 MB')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25')
  const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
  await act(async () => cancel!.click())
  expect(container.textContent).toBe('')
  act(() => root.unmount())
})
