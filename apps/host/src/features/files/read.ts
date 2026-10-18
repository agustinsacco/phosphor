import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { FILE_LIMITS, type FileRead } from '@phosphor/shared/host-protocol-files'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { FeatureOutcome } from '../feature'

export interface ReadPorts {
  checkedPath(root: string, path: string, missing?: boolean): Promise<string>
  readResult(bytes: Buffer, size?: number): FileRead
  error(code: CallErrorCode): Error
}

export async function guardedRead(
  root: string,
  path: string,
  recheck: () => void,
  ports: ReadPorts,
): Promise<FeatureOutcome> {
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
    const bytes = Buffer.alloc(Math.min(after.size + 1, FILE_LIMITS.textBytes + 1))
    let count = 0
    while (count < bytes.length) {
      const r = await handle.read(bytes, count, bytes.length - count, count)
      if (!r.bytesRead) break
      count += r.bytesRead
    }
    recheck()
    return {
      ok: true,
      data: {
        ...ports.readResult(bytes.subarray(0, count), Math.max(after.size, count)),
        revision: createHash('sha256').update(bytes.subarray(0, count)).digest('hex'),
      },
    }
  } finally {
    await handle.close()
  }
}
