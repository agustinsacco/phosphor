import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, renameSync } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'

export class SettingsFailure extends Error {
  constructor(
    readonly code: 'bad-request' | 'forbidden' | 'internal',
    message: string,
  ) {
    super(message)
  }
}
const locks = new Map<string, Promise<unknown>>()
/** Shared with repository registration. Process-local, not a cross-process filesystem lock. */
export async function withSettingsFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(run)
  locks.set(path, pending)
  try {
    return await pending
  } finally {
    if (locks.get(path) === pending) locks.delete(path)
  }
}
export function settingsFile(path: string): { raw: Record<string, unknown>; revision: string } {
  let bytes: Buffer = Buffer.alloc(0)
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 64 * 1024 ||
        (stat.mode & 0o022) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new SettingsFailure(
          'forbidden',
          'Settings file is not a private, owned regular file.',
        )
      const bounded = Buffer.alloc(64 * 1024 + 1)
      let count = 0
      while (count < bounded.length) {
        const read = readSync(fd, bounded, count, bounded.length - count, count)
        if (!read) break
        count += read
      }
      if (count > 64 * 1024)
        throw new SettingsFailure('bad-request', 'Settings exceed their size limit.')
      bytes = bounded.subarray(0, count)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  let raw: unknown = {}
  try {
    if (bytes.length) raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new SettingsFailure(
      'bad-request',
      'Settings are not valid JSON. Nothing was overwritten.',
    )
  }
  if (!machineRecord(raw))
    throw new SettingsFailure('bad-request', 'Settings must be a JSON object.')
  return { raw, revision: createHash('sha256').update(bytes).digest('hex') }
}
/** Caller holds the file lock and patches the latest object, preserving unrelated keys. */
export async function saveSettingsFile(
  path: string,
  raw: Record<string, unknown>,
  revision: string,
  authorized: () => boolean,
): Promise<void> {
  const bytes = JSON.stringify(raw, null, 2) + '\n'
  if (Buffer.byteLength(bytes) > 64 * 1024)
    throw new SettingsFailure('bad-request', 'Settings exceed their size limit.')
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = lstatSync(parent)
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o022) !== 0 ||
    (process.getuid && directory.uid !== process.getuid())
  )
    throw new SettingsFailure('forbidden', 'Settings directory is not safe to modify.')
  const temporary = join(parent, `.settings-${randomUUID()}.tmp`)
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    if (!authorized()) throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
    // No async seam from comparison to rename. External edits observed here are rejected.
    if (settingsFile(path).revision !== revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    renameSync(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
