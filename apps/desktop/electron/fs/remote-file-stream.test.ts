import { describe, expect, it, vi } from 'vitest'
import { FILE_BYTES_LIMITS } from '@shared/host-protocol-file-bytes'
import type { ChunkReader } from '@phosphor/host-client/file-bytes'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

const { grantRemotePreview, serveFileRequest } = await import('./file-protocol')
const { streamsFromHost } = await import('./remote-file-stream')

const STEP = FILE_BYTES_LIMITS.chunkBytes

/** A Host file of `size` bytes, each the low byte of its offset; `version` can move. */
function hostFile(size: number) {
  const state = { version: 'a'.repeat(32), calls: [] as [number, number][] }
  const read: ChunkReader = async (offset, length) => {
    state.calls.push([offset, length])
    const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset)))
    for (let i = 0; i < bytes.length; i++) bytes[i] = (offset + i) & 0xff
    return { size, version: state.version, bytes }
  }
  return { read, state }
}

const get = (url: string, range?: string) =>
  serveFileRequest(new Request(url, range ? { headers: { range } } : {}))

describe('remote previews', () => {
  it('stream media and PDFs only; text kinds render from what the Host sent', () => {
    for (const path of ['a.mp4', 'a.mov', 'a.png', 'a.mp3', 'a.pdf'])
      expect(streamsFromHost(path)).toBe(true)
    for (const path of ['a.svg', 'a.html', 'a.md', 'a.zip', 'a.ts'])
      expect(streamsFromHost(path)).toBe(false)
  })

  it('serve a whole file from the Host as its type, under the file policy', async () => {
    const file = hostFile(10)
    const url = await grantRemotePreview('w:s:renders/clip.mp4', 'renders/clip.mp4', file.read)
    expect(url).toMatch(/^phosphor-file:\/\/[0-9a-f]{32}\/clip\.mp4$/)
    const response = await get(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('content-length')).toBe('10')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  it('answer a range a chunk at a time, reading only what is asked for', async () => {
    const file = hostFile(STEP * 3)
    const url = await grantRemotePreview('w:s:big.mp4', 'big.mp4', file.read)
    const start = STEP + 10
    const response = await get(url, `bytes=${start}-${start + STEP}`)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes ${start}-${start + STEP}/${STEP * 3}`)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.length).toBe(STEP + 1)
    expect(body[0]).toBe(start & 0xff)
    expect(file.state.calls).toEqual([
      [0, 0],
      [start, STEP],
      [start + STEP, 1],
    ])
    expect((await get(url, `bytes=${STEP * 3}-`)).status).toBe(416)
  })

  it('error the stream when the file changed since it was granted, and re-read it on asking again', async () => {
    const file = hostFile(STEP * 2)
    const url = await grantRemotePreview('w:s:clip.mp4', 'clip.mp4', file.read)
    file.state.version = 'b'.repeat(32)
    await expect((await get(url)).arrayBuffer()).rejects.toThrow()
    expect(await grantRemotePreview('w:s:clip.mp4', 'clip.mp4', file.read)).toBe(url)
    expect((await (await get(url)).arrayBuffer()).byteLength).toBe(STEP * 2)
  })

  it('refuse a kind it does not stream, and a file its Host refuses', async () => {
    await expect(
      grantRemotePreview('w:s:page.html', 'page.html', hostFile(1).read),
    ).rejects.toThrow()
    const refused: ChunkReader = () => Promise.reject(new Error('Larger than 1 GB'))
    await expect(grantRemotePreview('w:s:huge.mp4', 'huge.mp4', refused)).rejects.toThrow()
  })
})
