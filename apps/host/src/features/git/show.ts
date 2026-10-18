import { FILE_LIMITS, type FileRead } from '@phosphor/shared/host-protocol-files'
import { FileFailure, readResult, safeGit } from '../files'

export async function readGitObject(
  root: string,
  prefix: string,
  path?: string,
  ref?: string,
): Promise<FileRead> {
  if (!path || !ref) throw new FileFailure('bad-request')
  const tree = (
    await safeGit(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`])
  ).trim()
  const treePath = prefix + path
  const listing = await safeGit(root, ['ls-tree', '--full-tree', '-z', tree, '--', treePath])
  const entry = listing.split('\0').find((s) => s.slice(s.indexOf('\t') + 1) === treePath)
  if (!entry) throw new FileFailure('bad-request')
  const [mode, type, object] = entry.slice(0, entry.indexOf('\t')).split(' ')
  if (!object || type !== 'blob' || !['100644', '100755'].includes(mode ?? ''))
    throw new FileFailure('bad-request')
  const size = Number((await safeGit(root, ['cat-file', '-s', object])).trim())
  if (!Number.isSafeInteger(size) || size < 0) throw new FileFailure('internal')
  // The shared runner has its own 64 MiB buffer cap; avoid materializing oversized blobs.
  if (size > FILE_LIMITS.textBytes) throw new FileFailure('too-large')
  const content = await safeGit(root, ['cat-file', 'blob', object], FILE_LIMITS.textBytes)
  return readResult(Buffer.from(content), size)
}
