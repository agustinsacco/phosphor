import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_BYTES_ERRORS } from '@shared/host-protocol-file-bytes'
import type { ChunkReader } from '@phosphor/host-client/file-bytes'

const downloads = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => downloads.dir } }))

const { cancelHostDownload, downloadHostFile, parseDownloadRequest, FILE_DOWNLOAD_PROGRESS } =
  await import('./host-download')

const ID = '0b6f8a1e-4c2d-4e8f-9a1b-2c3d4e5f6a7b'
const VERSION = 'a'.repeat(32)
const text =
  (content: string): ChunkReader =>
  async (offset, length) => ({
    size: content.length,
    version: VERSION,
    bytes: new TextEncoder().encode(content.slice(offset, offset + length)),
  })

function windowFake() {
  const destroyed = new Set<() => void>()
  return {
    id: 7,
    send: vi.fn(),
    isDestroyed: () => false,
    once: (_: 'destroyed', listener: () => void) => destroyed.add(listener),
    removeListener: (_: 'destroyed', listener: () => void) => destroyed.delete(listener),
    destroy: () => destroyed.forEach((listener) => listener()),
    listeners: () => destroyed.size,
  }
}

let root: string
beforeEach(async () => {
  root = downloads.dir = await mkdtemp(join(tmpdir(), 'host-download-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('downloadHostFile', () => {
  it('saves the file under its own name in Downloads and reports the end', async () => {
    const win = windowFake()
    const result = await downloadHostFile(win, { id: ID, path: 'renders/clip.mp4' }, text('frames'))
    expect(result.savedTo).toBe(join(downloads.dir, 'clip.mp4'))
    expect(await readFile(result.savedTo, 'utf8')).toBe('frames')
    expect(win.send).toHaveBeenLastCalledWith(FILE_DOWNLOAD_PROGRESS, {
      id: ID,
      received: 6,
      size: 6,
    })
    expect(win.listeners()).toBe(0)
  })

  it('cancels from the same window only, and leaves nothing behind', async () => {
    const win = windowFake()
    const run = (cancelFrom: number) => {
      let release: (() => void) | undefined
      const held: ChunkReader = async (offset, length) => {
        await new Promise<void>((r) => (release = r))
        return text('frames')(offset, length)
      }
      const running = downloadHostFile(win, { id: ID, path: 'clip.mp4' }, held)
      return vi
        .waitFor(() => expect(release).toBeDefined())
        .then(() => {
          cancelHostDownload(cancelFrom, ID)
          release!()
          return running
        })
    }
    await expect(run(8)).resolves.toEqual({ savedTo: join(downloads.dir, 'clip.mp4') })
    await rm(join(downloads.dir, 'clip.mp4'))
    await expect(run(7)).rejects.toThrow(FILE_BYTES_ERRORS.cancelled)
    expect(await readdir(downloads.dir)).toEqual([])
  })

  it('stops when its window goes', async () => {
    const win = windowFake()
    let release!: () => void
    const held: ChunkReader = async (offset, length) => {
      await new Promise<void>((r) => (release = r))
      return text('x')(offset, length)
    }
    const running = downloadHostFile(win, { id: ID, path: 'clip.mp4' }, held)
    await vi.waitFor(() => expect(release).toBeDefined())
    win.destroy()
    release()
    await expect(running).rejects.toThrow(FILE_BYTES_ERRORS.cancelled)
  })

  it('crosses only fixed text', async () => {
    const win = windowFake()
    const fail =
      (message: string): ChunkReader =>
      () =>
        Promise.reject(new Error(message))
    await expect(
      downloadHostFile(win, { id: ID, path: 'a' }, fail('/secret/path')),
    ).rejects.toThrow(FILE_BYTES_ERRORS.failed)
    await expect(
      downloadHostFile(win, { id: ID, path: 'a' }, fail(FILE_BYTES_ERRORS.tooLarge)),
    ).rejects.toThrow(FILE_BYTES_ERRORS.tooLarge)
    await writeFile(join(downloads.dir, 'file'), '')
    downloads.dir = join(downloads.dir, 'file', 'Downloads')
    await expect(downloadHostFile(win, { id: ID, path: 'a' }, text('x'))).rejects.toThrow(
      'Could not save into your Downloads folder.',
    )
  })
})

describe('parseDownloadRequest', () => {
  it('takes a lane handle, a lane-relative path and a uuid', () => {
    expect(parseDownloadRequest({ sessionId: 'remote-1', path: 'a/b.mp4', id: ID })).toEqual({
      sessionId: 'remote-1',
      path: 'a/b.mp4',
      id: ID,
    })
    expect(parseDownloadRequest({ sessionId: 'remote-1', path: '../b', id: ID })).toBeNull()
    expect(parseDownloadRequest({ sessionId: 'remote-1', path: 'b', id: 'x' })).toBeNull()
    expect(parseDownloadRequest(null)).toBeNull()
  })
})
