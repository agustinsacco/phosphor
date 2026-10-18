import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { errnoIs, isOwnerPrivate } from '../fs-safety'
import { IdentityFailure, isHostKeyFile, unsafeIdentity } from './identity-records'
import type { IdentityLocation } from './identity-types'

/** Largest identity file read. Keys and metadata are far smaller. */
const MAX_FILE_BYTES = 4096
/** Most directory entries one key cleanup scans before it refuses. */
const MAX_SCAN_ENTRIES = 1000

/** Only an Error carrying ENOENT counts as missing. */
export const isMissing = (error: unknown) => error instanceof Error && errnoIs(error, 'ENOENT')

/** The directory's lstat. A missing directory rejects with the raw ENOENT. */
export async function checkIdentityDirectory(directory: string, uid: number | undefined) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || !isOwnerPrivate(info, uid))
    throw unsafeIdentity()
  return info
}

/** The checked directory, or null when it is missing. Any other problem is unsafe. */
export async function existingIdentityDirectory(
  directory: string,
  uid: number | undefined,
): Promise<Stats | null> {
  try {
    return await checkIdentityDirectory(directory, uid)
  } catch (error) {
    if (isMissing(error)) return null
    throw unsafeIdentity()
  }
}

/** Create the directory owner-only when absent, then check it. mkdir errors pass through raw. */
export async function ensureIdentityDirectory(directory: string, uid: number | undefined) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await checkIdentityDirectory(directory, uid)
}

/**
 * Read an owner-private regular file through a descriptor that follows no
 * symlink and never blocks, rechecking what was opened. A missing file
 * rejects with the raw ENOENT; locks rely on the returned descriptor stat.
 */
export async function readIdentityFileSnapshot(
  directory: string,
  uid: number | undefined,
  name: string,
) {
  const path = join(directory, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || !isOwnerPrivate(info, uid)) throw unsafeIdentity()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const actual = await file.stat()
    if (!actual.isFile() || !isOwnerPrivate(actual, uid) || actual.size > MAX_FILE_BYTES)
      throw unsafeIdentity()
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_FILE_BYTES) throw unsafeIdentity()
    return { text: bytes.subarray(0, bytesRead).toString('utf8'), info: actual }
  } finally {
    await file.close()
  }
}

export async function readIdentityFile(directory: string, uid: number | undefined, name: string) {
  return (await readIdentityFileSnapshot(directory, uid, name)).text
}

/** Whether anything, even a dangling symlink, is at `path`. Other errors pass through raw. */
export async function identityEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** Unlink `name` if present. Any failure other than missing is unsafe. */
export async function removeIdentityFile(directory: string, name: string) {
  await unlink(join(directory, name)).catch((error: unknown) => {
    if (!isMissing(error)) throw unsafeIdentity()
  })
}

/**
 * Publish `text` as `name`: write an owner-only temp file, sync and close it,
 * check the signal, then rename it into place. The temp file never survives.
 */
export async function writeIdentityFileAtomic(
  { directory, ports }: IdentityLocation,
  name: string,
  text: string,
  signal?: AbortSignal,
) {
  const temp = `.host-${randomUUID()}.tmp`
  try {
    const file = await open(join(directory, temp), 'wx', 0o600)
    try {
      await file.writeFile(text)
      await file.sync()
    } finally {
      await file.close()
    }
    signal?.throwIfAborted()
    await ports.rename(join(directory, temp), join(directory, name))
  } finally {
    await removeIdentityFile(directory, temp)
  }
}

/** Remove every host-key.<uuid>.pem except `keep`. Unlink errors pass through raw. */
export async function cleanHostKeys(directory: string, keep?: string) {
  const dir = await opendir(directory)
  let count = 0
  for await (const entry of dir) {
    if (++count > MAX_SCAN_ENTRIES)
      throw new IdentityFailure('Too many identity files. Remove unused host-key files.')
    if (isHostKeyFile(entry.name) && entry.name !== keep) await unlink(join(directory, entry.name))
  }
}
