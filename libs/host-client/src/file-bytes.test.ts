import { describe, expect, it, vi } from 'vitest'
import { FILE_BYTES_ERRORS, FILE_BYTES_LIMITS } from '@phosphor/shared/host-protocol-file-bytes'
import { laneFileReader, READS_PER_CONNECTION, transferFile, type ChunkReader } from './file-bytes'

const STEP = FILE_BYTES_LIMITS.chunkBytes
const laneId = '7f1c2a4e-9b3d-4c5e-8f6a-1b2c3d4e5f60'
const VERSION = 'a'.repeat(32)

/** A file of `size` bytes, each the low byte of its offset, served a chunk at a time. */
function fileOf(size: number, version = () => VERSION): ChunkReader {
  return async (offset, length) => {
    const bytes = new Uint8Array(Math.min(length, size - offset))
    for (let i = 0; i < bytes.length; i++) bytes[i] = (offset + i) & 0xff
    return { size, version: version(), bytes }
  }
}

function collect() {
  const parts = new Map<number, Uint8Array>()
  const write = vi.fn(async (bytes: Uint8Array, offset: number) => {
    parts.set(offset, bytes)
  })
  const joined = () =>
    Buffer.concat([...parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b))
  return { write, joined }
}

describe('transferFile', () => {
  it('copies every chunk to its offset and reports progress to the end', async () => {
    const size = STEP * 3 + 5
    const { write, joined } = collect()
    const progress: number[] = []
    expect(
      await transferFile(fileOf(size), write, { onProgress: (r, s) => progress.push(r / s) }),
    ).toBe(size)
    expect(joined().length).toBe(size)
    expect(joined()[STEP + 7]).toBe((STEP + 7) & 0xff)
    expect(progress.at(-1)).toBe(1)
    expect(write).toHaveBeenCalledTimes(4)
  })

  it('copies an empty file', async () => {
    const { write } = collect()
    expect(await transferFile(fileOf(0), write)).toBe(0)
  })

  it('refuses a file that changed between chunks, after every chunk in flight settles', async () => {
    let calls = 0
    const read = fileOf(STEP * 6, () => (++calls > 2 ? 'b'.repeat(32) : VERSION))
    const { write } = collect()
    await expect(transferFile(read, write)).rejects.toThrow(FILE_BYTES_ERRORS.changed)
    const writes = write.mock.calls.length
    await new Promise((r) => setTimeout(r, 10))
    expect(write.mock.calls.length).toBe(writes)
  })

  it('stops when cancelled', async () => {
    const abort = new AbortController()
    const { write } = collect()
    const read: ChunkReader = async (offset, length) => {
      if (offset > 0) abort.abort()
      return fileOf(STEP * 10)(offset, length)
    }
    await expect(transferFile(read, write, { signal: abort.signal })).rejects.toThrow(
      FILE_BYTES_ERRORS.cancelled,
    )
    expect(write.mock.calls.length).toBeLessThan(10)
  })
})

describe('laneFileReader', () => {
  const answer = (result: unknown) => ({ call: vi.fn(async () => result as never) })

  it('asks for one window of a lane file and decodes it', async () => {
    const c = answer({
      type: 'result',
      ok: true,
      data: { size: 3, version: VERSION, data: Buffer.from('abc').toString('base64') },
    })
    const chunk = await laneFileReader(c, laneId, 'renders/a.mp4')(0, 8)
    expect(c.call).toHaveBeenCalledWith('files.readBytes', {
      laneId,
      path: 'renders/a.mp4',
      offset: 0,
      length: 8,
    })
    expect(Buffer.from(chunk.bytes).toString()).toBe('abc')
  })

  it('keeps at most four chunk reads in flight per connection, across readers', async () => {
    let active = 0
    let peak = 0
    const c = {
      call: vi.fn(async () => {
        peak = Math.max(peak, ++active)
        await new Promise((r) => setTimeout(r, 1))
        active--
        return {
          type: 'result',
          ok: true,
          data: { size: 1, version: VERSION, data: 'AA==' },
        } as never
      }),
    }
    const reads = ['a', 'b', 'c'].flatMap((path) =>
      Array.from({ length: 4 }, () => laneFileReader(c, laneId, path)(0, 1)),
    )
    await Promise.all(reads)
    expect(c.call).toHaveBeenCalledTimes(12)
    expect(peak).toBe(READS_PER_CONNECTION)
    // A failed read gives its slot back.
    c.call.mockRejectedValueOnce(new Error('gone'))
    await expect(laneFileReader(c, laneId, 'a')(0, 1)).rejects.toThrow(FILE_BYTES_ERRORS.failed)
    await Promise.all(Array.from({ length: 4 }, () => laneFileReader(c, laneId, 'a')(0, 1)))
  })

  it('names refusals in fixed text', async () => {
    const refused = (code: string) =>
      answer({ type: 'result', ok: false, error: { code, message: 'Host words' } })
    const read = (c: ReturnType<typeof answer>) => laneFileReader(c, laneId, 'a')(0, 1)
    await expect(read(refused('too-large'))).rejects.toThrow(FILE_BYTES_ERRORS.tooLarge)
    await expect(read(refused('unsupported'))).rejects.toThrow(FILE_BYTES_ERRORS.outdated)
    await expect(read(refused('internal'))).rejects.toThrow(FILE_BYTES_ERRORS.failed)
    await expect(read(answer({ type: 'result', ok: true, data: { size: 1 } }))).rejects.toThrow(
      FILE_BYTES_ERRORS.failed,
    )
    await expect(laneFileReader(answer(null), laneId, '../x')(0, 1)).rejects.toThrow(
      FILE_BYTES_ERRORS.failed,
    )
  })
})
