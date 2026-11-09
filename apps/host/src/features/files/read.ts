import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { FILE_LIMITS, type FileRead } from '@phosphor/shared/host-protocol-files'
import {
  FILE_BYTES_LIMITS,
  type FileBytes,
  type FileBytesParams,
} from '@phosphor/shared/host-protocol-file-bytes'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { FeatureOutcome } from '../feature'

export interface ReadPorts {
  checkedPath(root: string, path: string, missing?: boolean): Promise<string>
  readResult(bytes: Buffer, size?: number): FileRead
  error(code: CallErrorCode): Error
}

/**
 * Open `path` under `root` for reading, refusing links, non-files and a file
 * swapped between the check and the open. Closes the handle after `use`.
 */
async function withGuardedFile<T>(
  root: string,
  path: string,
  ports: ReadPorts,
  use: (handle: FileHandle, size: number) => Promise<T>,
): Promise<T> {
  const full = await ports.checkedPath(root, path, true)
  const before = await lstat(full)
  if (!before.isFile()) throw ports.error('bad-request')
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const after = await handle.stat()
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino)
      throw ports.error('bad-request')
    await ports.checkedPath(root, path)
    const current = await lstat(full)
    if (current.dev !== after.dev || current.ino !== after.ino) throw ports.error('bad-request')
    return await use(handle, after.size)
  } finally {
    await handle.close()
  }
}

/** Fill `bytes` from `position`, stopping early at the file's end. */
async function readInto(handle: FileHandle, bytes: Buffer, position: number): Promise<number> {
  let count = 0
  while (count < bytes.length) {
    const r = await handle.read(bytes, count, bytes.length - count, position + count)
    if (!r.bytesRead) break
    count += r.bytesRead
  }
  return count
}

export function guardedRead(
  root: string,
  path: string,
  recheck: () => void,
  ports: ReadPorts,
): Promise<FeatureOutcome> {
  return withGuardedFile(root, path, ports, async (handle, size) => {
    const bytes = Buffer.alloc(Math.min(size + 1, FILE_LIMITS.textBytes + 1))
    const count = await readInto(handle, bytes, 0)
    recheck()
    return {
      ok: true,
      data: {
        ...ports.readResult(bytes.subarray(0, count), Math.max(size, count)),
        revision: createHash('sha256').update(bytes.subarray(0, count)).digest('hex'),
      },
    }
  })
}

/**
 * One chunk of a file of at most `FILE_BYTES_LIMITS.fileBytes`. `version` hashes
 * the file's identity, size and change times, so it moves whenever the bytes may have.
 */
export function guardedBytes(
  root: string,
  p: Pick<FileBytesParams, 'path' | 'offset' | 'length'>,
  recheck: () => void,
  ports: ReadPorts,
): Promise<FeatureOutcome> {
  return withGuardedFile(root, p.path, ports, async (handle) => {
    const info = await handle.stat({ bigint: true })
    const size = Number(info.size)
    if (size > FILE_BYTES_LIMITS.fileBytes) throw ports.error('too-large')
    if (p.offset > size) throw ports.error('bad-request')
    const bytes = Buffer.alloc(Math.min(p.length, size - p.offset))
    // A file that shrank mid-read answers short, which the client refuses as torn.
    const count = await readInto(handle, bytes, p.offset)
    recheck()
    const version = createHash('sha256')
      .update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
      .digest('hex')
      .slice(0, 32)
    const data: FileBytes = { size, version, data: bytes.subarray(0, count).toString('base64') }
    return { ok: true, data }
  })
}
