// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BROWSER_FILE_BYTES,
  FILE_BYTES_ERRORS,
  FILE_BYTES_LIMITS,
} from '@phosphor/shared/host-protocol-file-bytes'
import { createBrowserFileBytes } from './file-bytes'

const saved = vi.hoisted(() => [] as { name: string; data: Uint8Array }[])
vi.mock('@phosphor/shared/download', () => ({
  downloadBytes: (name: string, data: Uint8Array) => saved.push({ name, data }),
}))

const ID = '0b6f8a1e-4c2d-4e8f-9a1b-2c3d4e5f6a7b'
const VERSION = 'a'.repeat(32)
const LANE = '7f1c2a4e-9b3d-4c5e-8f6a-1b2c3d4e5f60'
const STEP = FILE_BYTES_LIMITS.chunkBytes

/** A Host that serves one file of `size` bytes, each the low byte of its offset. */
function host(size: number, hold?: Promise<void>) {
  const calls: { laneId: string; path: string; offset: number }[] = []
  const connection = {
    call: vi.fn(async (_method: string, params: unknown) => {
      const { laneId, path, offset, length } = params as {
        laneId: string
        path: string
        offset: number
        length: number
      }
      calls.push({ laneId, path, offset })
      await hold
      const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset)))
      for (let i = 0; i < bytes.length; i++) bytes[i] = (offset + i) & 0xff
      const data = Buffer.from(bytes).toString('base64')
      return {
        type: 'result' as const,
        id: '1',
        ok: true as const,
        data: { size, version: VERSION, data },
      }
    }),
  }
  const lanes = {
    onLane: vi.fn(
      <T>(_window: number, id: string, read: (c: never, laneId: string) => Promise<T>) => {
        if (id !== 'remote-1') return Promise.reject(new Error('Unknown lane handle'))
        return read(connection as never, LANE)
      },
    ),
  }
  return { calls, lanes }
}

const progress = vi.fn()
const created: Blob[] = []
beforeEach(() => {
  saved.length = 0
  created.length = 0
  progress.mockReset()
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob)
    return `blob:https://app/${created.length}`
  })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => vi.restoreAllMocks())

it('downloads a Host file as a browser download, under its own name, with its progress', async () => {
  const { lanes, calls } = host(STEP + 10)
  const bytes = createBrowserFileBytes({ lanes, progress })
  await expect(
    bytes.download({ sessionId: 'remote-1', path: 'renders/clip.mp4', id: ID }),
  ).resolves.toEqual({ savedTo: 'clip.mp4' })
  expect(saved).toHaveLength(1)
  expect(saved[0]!.name).toBe('clip.mp4')
  expect(saved[0]!.data.length).toBe(STEP + 10)
  expect(saved[0]!.data[STEP + 3]).toBe((STEP + 3) & 0xff)
  expect(calls.every((c) => c.laneId === LANE && c.path === 'renders/clip.mp4')).toBe(true)
  expect(progress).toHaveBeenLastCalledWith({ id: ID, received: STEP + 10, size: STEP + 10 })
})

it('refuses a file over the browser’s cap after one chunk, and saves nothing', async () => {
  const { lanes, calls } = host(BROWSER_FILE_BYTES.downloadBytes + 1)
  const bytes = createBrowserFileBytes({ lanes, progress })
  await expect(bytes.download({ sessionId: 'remote-1', path: 'big.bin', id: ID })).rejects.toThrow(
    FILE_BYTES_ERRORS.browserTooLarge,
  )
  expect(calls).toHaveLength(1)
  expect(saved).toHaveLength(0)
})

it('cancels a running download, which then saves nothing', async () => {
  let release: () => void = () => {}
  const { lanes } = host(10, new Promise<void>((r) => (release = r)))
  const bytes = createBrowserFileBytes({ lanes, progress })
  const running = bytes.download({ sessionId: 'remote-1', path: 'a.txt', id: ID })
  bytes.cancel(ID)
  release()
  await expect(running).rejects.toThrow(FILE_BYTES_ERRORS.cancelled)
  expect(saved).toHaveLength(0)
})

it('crosses only fixed text, and refuses a malformed request or another lane', async () => {
  const { lanes } = host(10)
  const bytes = createBrowserFileBytes({ lanes, progress })
  await expect(bytes.download({ sessionId: 'remote-1', path: '../x', id: ID })).rejects.toThrow(
    FILE_BYTES_ERRORS.failed,
  )
  await expect(bytes.download({ sessionId: 'other', path: 'a.txt', id: ID })).rejects.toThrow(
    FILE_BYTES_ERRORS.failed,
  )
})

it('previews an image as a Blob typed by its extension, never by the Host', async () => {
  const { lanes } = host(16)
  const bytes = createBrowserFileBytes({ lanes, progress })
  await expect(bytes.previewUrl({ sessionId: 'remote-1', path: 'art/logo.png' })).resolves.toBe(
    'blob:https://app/1',
  )
  expect(created[0]!.type).toBe('image/png')
  expect(created[0]!.size).toBe(16)
  await bytes.previewUrl({ sessionId: 'remote-1', path: 'clip.webm' })
  expect(created[1]!.type).toBe('video/webm')
})

it('previews only images and media: never a PDF, SVG, HTML or unknown file', async () => {
  const { lanes, calls } = host(16)
  const bytes = createBrowserFileBytes({ lanes, progress })
  for (const path of ['doc.pdf', 'logo.svg', 'page.html', 'notes.md', 'data.bin', 'a.ts'])
    await expect(bytes.previewUrl({ sessionId: 'remote-1', path })).rejects.toThrow()
  expect(calls).toHaveLength(0)
  expect(created).toHaveLength(0)
})

it('refuses a preview over its cap without making a URL', async () => {
  const { lanes, calls } = host(BROWSER_FILE_BYTES.previewBytes + 1)
  const bytes = createBrowserFileBytes({ lanes, progress })
  await expect(bytes.previewUrl({ sessionId: 'remote-1', path: 'clip.mp4' })).rejects.toThrow()
  expect(calls).toHaveLength(1)
  expect(created).toHaveLength(0)
})

it('a newer preview of the lane revokes the last one, and another owner revokes them all', async () => {
  const { lanes } = host(16)
  const bytes = createBrowserFileBytes({ lanes, progress })
  const first = await bytes.previewUrl({ sessionId: 'remote-1', path: 'a.png' })
  const second = await bytes.previewUrl({ sessionId: 'remote-1', path: 'b.png' })
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(first)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(second)
  bytes.clear()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(second)
})

it('another owner stops a running download', async () => {
  let release: () => void = () => {}
  const { lanes } = host(10, new Promise<void>((r) => (release = r)))
  const bytes = createBrowserFileBytes({ lanes, progress })
  const running = bytes.download({ sessionId: 'remote-1', path: 'a.txt', id: ID })
  bytes.clear()
  release()
  await expect(running).rejects.toThrow(FILE_BYTES_ERRORS.cancelled)
  expect(saved).toHaveLength(0)
})
