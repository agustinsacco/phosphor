import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FILE_LIMITS, isFilePath } from '@phosphor/shared/host-protocol-files'
import { filesystemCode } from '@phosphor/session-runtime/files/mutations'
import type { RejectCode } from '@phosphor/shared/host-protocol'

export class WriteFailure extends Error {
  constructor(readonly code: RejectCode) {
    super(code)
  }
}
/** Node lacks openat. Refuse all symlinks, then recheck immediately before mutation.
 * A same-user actor can still replace an ancestor between check and syscall.
 */
export async function mutationPath(root: string, path: string, missing = false): Promise<string> {
  if (!isFilePath(path)) throw new WriteFailure('bad-request')
  let current = root
  const components = path.split('/')
  for (let i = 0; i < components.length; i++) {
    current = join(current, components[i] ?? '')
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (i < components.length - 1 && !info.isDirectory()))
        throw new WriteFailure('bad-request')
    } catch (error) {
      if (!(missing && i === components.length - 1 && filesystemCode(error) === 'ENOENT'))
        throw error
    }
  }
  if ((await realpath(root)) !== root || (await realpath(dirname(current))) !== dirname(current))
    throw new WriteFailure('bad-request')
  return current
}
export async function revision(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile()) throw new WriteFailure('bad-request')
    if (info.size > FILE_LIMITS.textBytes) throw new WriteFailure('bad-request')
    const bytes = Buffer.alloc(FILE_LIMITS.textBytes + 1)
    let count = 0
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    if (count > FILE_LIMITS.textBytes) throw new WriteFailure('bad-request')
    return createHash('sha256').update(bytes.subarray(0, count)).digest('hex')
  } catch (error) {
    if (filesystemCode(error) === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close()
  }
}
