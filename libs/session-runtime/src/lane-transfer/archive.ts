import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { parseLaneManifest, type LaneManifest } from '@phosphor/shared/host-protocol-lane-transfer'
import type { CollectedLane } from './collect'
import { refuse } from './files'

/**
 * A lane bundle on disk: an 8-byte magic, a 4-byte big-endian manifest length,
 * the manifest JSON, then every part's bytes in manifest order. One file, so a
 * transfer is one size and one SHA-256, whichever machines it passes through.
 */
const MAGIC = Buffer.from('PHLANE01')
const MANIFEST_MAX = 4 * 1024 * 1024
const PREFIX = MAGIC.length + 4

function changed(): never {
  refuse('This lane changed while it was being read. Try again.')
}

/** Write `lane` to `path` (which must not exist), rehashing every part as it is copied. */
export async function writeArchive(
  lane: CollectedLane,
  path: string,
): Promise<{ size: number; sha256: string }> {
  const manifest = Buffer.from(JSON.stringify(lane.manifest), 'utf8')
  if (manifest.length > MANIFEST_MAX) refuse('This lane has too many files to move.')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(manifest.length)
  const total = createHash('sha256')
  const out = await open(path, 'wx', 0o600)
  let size = 0
  const write = async (bytes: Buffer) => {
    total.update(bytes)
    size += bytes.length
    let done = 0
    while (done < bytes.length) done += (await out.write(bytes, done)).bytesWritten
  }
  try {
    await write(Buffer.concat([MAGIC, length, manifest]))
    for (const [index, part] of lane.manifest.parts.entries()) {
      const hash = createHash('sha256')
      let read = 0
      for await (const chunk of createReadStream(lane.files[index]!)) {
        const bytes = chunk as Buffer
        read += bytes.length
        if (read > part.size) changed()
        hash.update(bytes)
        await write(bytes)
      }
      if (read !== part.size || hash.digest('hex') !== part.sha256) changed()
    }
    await out.sync()
  } finally {
    await out.close()
  }
  return { size, sha256: total.digest('hex') }
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface ArchiveReader {
  manifest: LaneManifest
  read(index: number): Promise<Buffer>
}

function invalid(): never {
  refuse('The lane bundle is damaged.')
}

async function readRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, offset + done)
    if (!bytesRead) invalid()
    done += bytesRead
  }
  return buffer
}

/**
 * Open a received bundle. The manifest is validated and every part's bytes are
 * hashed before this returns, so nothing is written from a bundle that does not
 * match itself.
 */
export async function openArchive(path: string): Promise<ArchiveReader> {
  const size = (await stat(path)).size
  const handle = await open(path, 'r')
  const range = (offset: number, length: number) => readRange(handle, offset, length)
  try {
    if (size < PREFIX) invalid()
    const prefix = await range(0, PREFIX)
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) invalid()
    const length = prefix.readUInt32BE(MAGIC.length)
    if (length > MANIFEST_MAX || PREFIX + length > size) invalid()
    let parsed: unknown
    try {
      parsed = JSON.parse((await range(PREFIX, length)).toString('utf8'))
    } catch {
      invalid()
    }
    const manifest = parseLaneManifest(parsed)
    if (!manifest) invalid()
    const offsets: number[] = []
    let offset = PREFIX + length
    for (const part of manifest.parts) {
      offsets.push(offset)
      offset += part.size
    }
    if (offset !== size) invalid()
    for (const [index, part] of manifest.parts.entries()) {
      const bytes = await range(offsets[index]!, part.size)
      if (createHash('sha256').update(bytes).digest('hex') !== part.sha256) invalid()
    }
    return {
      manifest,
      async read(index) {
        const part = manifest.parts[index]
        if (!part) invalid()
        const file = await open(path, 'r')
        let bytes: Buffer
        try {
          bytes = await readRange(file, offsets[index]!, part.size)
        } finally {
          await file.close()
        }
        if (createHash('sha256').update(bytes).digest('hex') !== part.sha256) invalid()
        return bytes
      },
    }
  } finally {
    await handle.close()
  }
}
