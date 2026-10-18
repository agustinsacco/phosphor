import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { readFileSync } from 'node:fs'
import type * as FsModule from 'node:fs'
import type * as FsPromisesModule from 'node:fs/promises'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { stageMacUpdate, type StagedMacUpdate } from './mac-installer'

/**
 * The sha512 gate in `stageMacUpdate`: nothing is extracted from an archive
 * whose digest differs from the manifest's. Only the network and the spawned
 * macOS tools are faked; the download, the hash and staging use the real
 * temp filesystem. The fake `ditto` reads the zip with `readFileSync`, so the
 * code under test is the only reader of the archive through `fs/promises`.
 */
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: vi.fn(),
}))

/** How the code under test reads the archive, for the streaming regression. */
const archiveIo = vi.hoisted(() => ({
  denyWholeRead: false,
  wholeReads: 0,
  streamChunkBytes: [] as (number | undefined)[],
  isArchive: (path: unknown): boolean => String(path).endsWith('phosphor.zip'),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  const readFile = (...args: Parameters<typeof actual.readFile>) => {
    if (archiveIo.isArchive(args[0])) {
      archiveIo.wholeReads += 1
      if (archiveIo.denyWholeRead) return Promise.reject(new Error('whole-archive read denied'))
    }
    return actual.readFile(...args)
  }
  return { ...actual, readFile }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  const createReadStream = (...args: Parameters<typeof actual.createReadStream>) => {
    const [path, options] = args
    if (archiveIo.isArchive(path)) {
      archiveIo.streamChunkBytes.push(
        typeof options === 'object' ? options?.highWaterMark : undefined,
      )
    }
    return actual.createReadStream(...args)
  }
  return { ...actual, createReadStream }
})

const VERSION = '9.9.9'
const ZIP_URL = `https://github.com/agustinsacco/Phosphor/releases/download/v${VERSION}/phosphor-${VERSION}-arm64-mac.zip`
/** Several megabytes, so a chunked hash needs more than one read. */
const ARCHIVE = patterned(3 * 1024 * 1024 + 123)

let parent: string
let spawned: string[]
let extractedSha512: string | null
const onInstallStart = vi.fn()

function patterned(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return bytes
}

function sha512(bytes: Buffer, encoding: 'base64' | 'hex' = 'base64'): string {
  return createHash('sha512').update(bytes).digest(encoding)
}

/** Each macOS tool succeeds, acting on the real temp filesystem. */
async function runTool(command: string, args: string[]): Promise<string> {
  if (command === '/usr/bin/ditto') {
    const [, , zip, dest] = args
    extractedSha512 = sha512(readFileSync(zip!))
    await mkdir(join(dest!, 'Phosphor.app', 'Contents'), { recursive: true })
  }
  if (command === '/bin/rm') await rm(args[2]!, { recursive: true, force: true })
  return command === '/usr/libexec/PlistBuddy' ? `${VERSION}\n` : ''
}

function fakeChild(command: string, args: readonly string[]): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  })
  spawned.push(basename(command))
  void runTool(command, [...args]).then((stdout) => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', 0)
  })
  return child as unknown as ChildProcess
}

function serve(body: Buffer): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(body))),
  )
}

function stage(expectedSha512: string): Promise<StagedMacUpdate> {
  return stageMacUpdate({
    bundlePath: join(parent, 'Phosphor.app'),
    version: VERSION,
    zipUrl: ZIP_URL,
    sha512: expectedSha512,
    onProgress: () => {},
    onInstallStart,
  })
}

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'phosphor-hash-test-'))
  await mkdir(join(parent, 'Phosphor.app'))
  spawned = []
  extractedSha512 = null
  onInstallStart.mockClear()
  vi.mocked(spawn).mockImplementation(fakeChild as unknown as typeof spawn)
  serve(ARCHIVE)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.mocked(spawn).mockReset()
  await rm(parent, { recursive: true, force: true })
})

describe('stageMacUpdate archive hash', () => {
  it('extracts the archive only after its sha512 matches the manifest', async () => {
    await expect(stage(sha512(ARCHIVE))).resolves.toMatchObject({ version: VERSION })

    expect(spawned[0]).toBe('ditto')
    expect(extractedSha512).toBe(sha512(ARCHIVE))
    expect(onInstallStart).toHaveBeenCalledTimes(1)
    expect(onInstallStart.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0]!,
    )
  })

  it('refuses an archive with one changed byte before install start or ditto', async () => {
    const tampered = Buffer.from(ARCHIVE)
    tampered[tampered.length - 1]! ^= 1

    await expect(stage(sha512(tampered))).rejects.toThrow(
      `sha512 mismatch for phosphor-${VERSION}-arm64-mac.zip`,
    )

    expect(spawned).toEqual(['rm'])
    expect(onInstallStart).not.toHaveBeenCalled()
    expect(extractedSha512).toBeNull()
  })

  it('compares the base64 digest, so the right digest in hex is refused', async () => {
    await expect(stage(sha512(ARCHIVE, 'hex'))).rejects.toThrow('sha512 mismatch')

    expect(spawned).toEqual(['rm'])
  })

  it('hashes an empty archive like any other', async () => {
    serve(Buffer.alloc(0))
    const emptySha512 =
      'z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='

    await expect(stage(emptySha512)).resolves.toMatchObject({ version: VERSION })
    expect(extractedSha512).toBe(emptySha512)
  })
})

describe('stageMacUpdate archive hash memory (regression r1-F19)', () => {
  beforeEach(() => {
    archiveIo.denyWholeRead = false
    archiveIo.wholeReads = 0
    archiveIo.streamChunkBytes = []
  })

  it('verifies the archive without reading it whole into memory', async () => {
    archiveIo.denyWholeRead = true

    await expect(stage(sha512(ARCHIVE))).resolves.toMatchObject({ version: VERSION })

    expect(archiveIo.wholeReads).toBe(0)
    expect(extractedSha512).toBe(sha512(ARCHIVE))
  })

  it('hashes the archive from one read stream in chunks smaller than the archive', async () => {
    await stage(sha512(ARCHIVE))

    expect(archiveIo.streamChunkBytes).toHaveLength(1)
    // An unset highWaterMark means Node's fs stream default, 64 KiB.
    const chunkBytes = archiveIo.streamChunkBytes[0] ?? 64 * 1024
    expect(chunkBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(chunkBytes).toBeLessThan(ARCHIVE.length)
  })
})
