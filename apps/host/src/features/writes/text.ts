import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, rename, link, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileWriteOp } from '@phosphor/shared/host-protocol-writes'
import { filesystemCode } from '@phosphor/session-runtime/files/mutations'
import { mutationPath, revision, WriteFailure } from './guards'

export async function writeText(root: string, op: Extract<FileWriteOp, { type: 'files.write' }>) {
  const target = await mutationPath(root, op.path, true)
  if ((await revision(target)) !== op.expected) throw new WriteFailure('conflict')
  const temp = join(dirname(target), `.phosphor-write-${randomUUID()}`)
  await mutationPath(root, op.path, true)
  const mode = op.expected === null ? 0o600 : (await lstat(target)).mode & 0o777
  const file = await open(temp, 'wx', mode)
  try {
    try {
      await file.writeFile(op.content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await mutationPath(root, op.path, true)
    if ((await revision(target)) !== op.expected) throw new WriteFailure('conflict')
    await mutationPath(root, op.path, true)
    // Existing files have a same-user final hash-to-rename window.
    if (op.expected === null) await link(temp, target)
    else await rename(temp, target)
    return {
      revision: createHash('sha256').update(op.content).digest('hex'),
      mtimeMs: (await lstat(target)).mtimeMs,
    }
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (filesystemCode(error) !== 'ENOENT') throw error
    })
  }
}
