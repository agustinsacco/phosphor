import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createHash, type Hash } from 'node:crypto'
import type * as CryptoModule from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import type * as FsModule from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ARCHIVE_HASH_CHUNK_BYTES, sha512Base64 } from './archive-hash'

/** Every hash created in this file, with its `update` calls observable. */
const hashes = vi.hoisted(() => ({ updates: [] as MockInstance<Hash['update']>[] }))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>()
  const createHash = (...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args)
    hashes.updates.push(vi.spyOn(hash, 'update'))
    return hash
  }
  return { ...actual, createHash }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

const EMPTY_SHA512 =
  'z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='
/** 2.5 MiB of `i % 251`, and its sha512 computed independently. */
const PATTERNED_BYTES = 2 * 1024 * 1024 + 512 * 1024
const PATTERNED_SHA512 =
  'Kja1Fv/uxqlMiiZqTyX/8ZnS2+9/wvkaizo5dig31OZ81mWF8YLIk+6HOKp+vRPtGB5Hcd6jjFGev9YUesVWpQ=='

let dir: string

function patterned(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return bytes
}

/** Hash `path`, returning the digest and the size of every chunk the hash was given. */
async function hashFile(path: string): Promise<{ digest: string; chunks: number[] }> {
  hashes.updates = []
  const digest = await sha512Base64(path)
  expect(hashes.updates).toHaveLength(1)
  return { digest, chunks: hashes.updates[0]!.mock.calls.map(([data]) => (data as Buffer).length) }
}

function openedStream(): ReadStream {
  expect(vi.mocked(createReadStream)).toHaveBeenCalledTimes(1)
  return vi.mocked(createReadStream).mock.results[0]!.value as ReadStream
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phosphor-archive-hash-'))
  vi.mocked(createReadStream).mockClear()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sha512Base64', () => {
  it('returns the known base64 sha512 of an empty file without updating the hash', async () => {
    const file = join(dir, 'empty.zip')
    await writeFile(file, '')

    await expect(hashFile(file)).resolves.toEqual({ digest: EMPTY_SHA512, chunks: [] })
  })

  it('returns the known base64 sha512 of a file spanning several chunks', async () => {
    const bytes = patterned(PATTERNED_BYTES)
    const file = join(dir, 'archive.zip')
    await writeFile(file, bytes)
    const whole = createHash('sha512').update(bytes).digest('base64')

    const { digest } = await hashFile(file)

    expect(digest).toBe(PATTERNED_SHA512)
    expect(digest).toBe(whole)
  })

  it('hands the hash chunks no larger than ARCHIVE_HASH_CHUNK_BYTES', async () => {
    const file = join(dir, 'archive.zip')
    await writeFile(file, patterned(PATTERNED_BYTES))

    const { chunks } = await hashFile(file)

    expect(chunks.length).toBe(Math.ceil(PATTERNED_BYTES / ARCHIVE_HASH_CHUNK_BYTES))
    expect(Math.max(...chunks)).toBeLessThanOrEqual(ARCHIVE_HASH_CHUNK_BYTES)
    expect(chunks.reduce((sum, size) => sum + size, 0)).toBe(PATTERNED_BYTES)
  })

  it('reads through one stream at the chunk size and closes it once hashed', async () => {
    const file = join(dir, 'archive.zip')
    await writeFile(file, patterned(PATTERNED_BYTES))

    await sha512Base64(file)

    expect(createReadStream).toHaveBeenCalledWith(file, {
      highWaterMark: ARCHIVE_HASH_CHUNK_BYTES,
    })
    const stream = openedStream()
    expect(stream.destroyed).toBe(true)
    expect(stream.closed).toBe(true)
  })

  it('rejects with the open error for a missing file and closes the stream', async () => {
    await expect(sha512Base64(join(dir, 'missing.zip'))).rejects.toMatchObject({ code: 'ENOENT' })

    expect(openedStream().closed).toBe(true)
  })

  it('rejects with the read error and closes the stream', async () => {
    const notAFile = join(dir, 'archive.zip')
    await mkdir(notAFile)

    await expect(sha512Base64(notAFile)).rejects.toMatchObject({ code: 'EISDIR' })

    expect(openedStream().closed).toBe(true)
  })

  it('rejects with an error raised mid-stream and destroys the stream', async () => {
    const failure = new Error('disk went away')
    const failing = Readable.from(
      (async function* () {
        yield Buffer.alloc(16)
        throw failure
      })(),
    )
    vi.mocked(createReadStream).mockImplementationOnce(() => failing as unknown as ReadStream)
    hashes.updates = []

    await expect(sha512Base64(join(dir, 'archive.zip'))).rejects.toBe(failure)

    expect(failing.destroyed).toBe(true)
    expect(hashes.updates[0]!.mock.calls.map(([data]) => (data as Buffer).length)).toEqual([16])
  })
})
