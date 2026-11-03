import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs'
import { chmod, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'

/**
 * The one writer for pi's JSON config files (`settings.json`, `mcp.json`,
 * `web-search.json`, a Host's own config): bounded read, validate, atomic
 * write over a revision, under a per-path lock. Desktop and a Host share it
 * and differ only in their `SettingsFilePolicy`.
 */

export class SettingsFailure extends Error {
  constructor(
    readonly code: 'bad-request' | 'forbidden' | 'internal',
    message: string,
    /** The file exists but holds no JSON object; it is never overwritten. */
    readonly malformed = false,
  ) {
    super(message)
  }
}

export interface SettingsFilePolicy {
  /**
   * Read and save through a symbolic link, so the link survives (This Mac:
   * dotfiles). Without it a file or parent that is a link, a hard link,
   * another user's or world-writable is refused.
   */
  followLinks: boolean
  /** A fixed mode for the saved file, or `'keep'` the existing file's (0644 for a new one). */
  mode: number | 'keep'
  /** The largest file read or written, in bytes. */
  maxBytes: number
}

/** A Host edits config as a shared service: owned regular files only, saved private. */
export const HOST_FILE_POLICY: SettingsFilePolicy = {
  followLinks: false,
  mode: 0o600,
  maxBytes: 64 * 1024,
}

/** This Mac edits the user's own dotfiles: links are followed and modes are theirs. */
export const DESKTOP_FILE_POLICY: SettingsFilePolicy = {
  followLinks: true,
  mode: 'keep',
  maxBytes: 4 * 1024 * 1024,
}

/** The same policy for a file that holds credentials: always saved 0600. */
export const privateFilePolicy = (policy: SettingsFilePolicy): SettingsFilePolicy => ({
  ...policy,
  mode: 0o600,
})

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

const owned = (uid: number): boolean => !process.getuid || uid === process.getuid()
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const tooLarge = () => new SettingsFailure('bad-request', 'Settings exceed their size limit.')
const NOT_REGULAR = 'Settings must be an owned regular file, not a link or world-writable file.'

/**
 * Without `followLinks`, a file that cannot be opened safely is refused like any
 * other unsafe file, so callers that mark a refused file keep loading.
 */
function refusedOpen(error: unknown, policy: SettingsFilePolicy): SettingsFailure | null {
  if (policy.followLinks) return null
  const code = error instanceof Error && 'code' in error ? error.code : null
  if (code === 'ELOOP' || code === 'EISDIR') return new SettingsFailure('forbidden', NOT_REGULAR)
  if (code === 'EACCES' || code === 'EPERM')
    return new SettingsFailure('forbidden', 'Settings cannot be read: permission denied.')
  return null
}

/** The file's bytes and their revision; a missing file is empty. Nothing is parsed. */
export function readSettingsBytes(
  path: string,
  policy: SettingsFilePolicy,
): { bytes: Buffer; revision: string } {
  let bytes: Buffer = Buffer.alloc(0)
  try {
    const nofollow = policy.followLinks ? 0 : constants.O_NOFOLLOW
    const fd = openSync(path, constants.O_RDONLY | nofollow | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        (!policy.followLinks && (stat.nlink !== 1 || (stat.mode & 0o002) !== 0 || !owned(stat.uid)))
      )
        throw new SettingsFailure('forbidden', NOT_REGULAR)
      // One byte past the expected size tells an oversized or growing file from a whole one.
      const bounded = Buffer.alloc(Math.min(stat.size, policy.maxBytes) + 1)
      let count = 0
      while (count < bounded.length) {
        const read = readSync(fd, bounded, count, bounded.length - count, count)
        if (!read) break
        count += read
      }
      if (count > policy.maxBytes) throw tooLarge()
      if (count > stat.size)
        throw new SettingsFailure('internal', 'Settings changed while being read. Try again.')
      bytes = bounded.subarray(0, count)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw refusedOpen(error, policy) ?? error
  }
  return { bytes, revision: sha256(bytes) }
}

/** The file as a JSON object (empty when missing or blank) and its revision. */
export function settingsFile(
  path: string,
  policy: SettingsFilePolicy,
): { raw: Record<string, unknown>; revision: string } {
  const { bytes, revision } = readSettingsBytes(path, policy)
  let raw: unknown = {}
  try {
    const text = bytes.toString('utf8')
    if (text.trim()) raw = JSON.parse(text)
  } catch {
    throw new SettingsFailure(
      'bad-request',
      'Settings are not valid JSON. Nothing was overwritten.',
      true,
    )
  }
  if (!machineRecord(raw))
    throw new SettingsFailure('bad-request', 'Settings must be a JSON object.', true)
  return { raw, revision }
}

/** Where a save lands: through a link to the file it names, when the policy follows links. */
function saveTarget(path: string, policy: SettingsFilePolicy): string {
  if (!policy.followLinks) return path
  try {
    return realpathSync.native(path)
  } catch {
    // A dangling link names its future file; a missing path is saved as itself.
    try {
      if (lstatSync(path).isSymbolicLink()) return resolve(dirname(path), readlinkSync(path))
    } catch {
      // Missing.
    }
    return path
  }
}

async function safeParent(parent: string, policy: SettingsFilePolicy): Promise<void> {
  await mkdir(parent, { recursive: true, ...(policy.followLinks ? {} : { mode: 0o700 }) })
  if (policy.followLinks) return
  const directory = lstatSync(parent)
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o002) !== 0 ||
    !owned(directory.uid)
  )
    throw new SettingsFailure('forbidden', 'Settings directory is not safe to modify.')
}

function savedMode(target: string, policy: SettingsFilePolicy): number {
  if (policy.mode !== 'keep') return policy.mode
  try {
    return statSync(target).mode & 0o777
  } catch {
    return 0o644
  }
}

/**
 * Atomically replace the file read at `revision` with `text`. The caller holds
 * the file lock; a file changed on disk since that read is refused.
 */
export async function writeSettingsText(
  path: string,
  text: string,
  revision: string,
  authorized: () => boolean,
  policy: SettingsFilePolicy,
): Promise<void> {
  if (Buffer.byteLength(text) > policy.maxBytes) throw tooLarge()
  const target = saveTarget(path, policy)
  const parent = dirname(target)
  await safeParent(parent, policy)
  const mode = savedMode(target, policy)
  const temporary = join(parent, `.settings-${randomUUID()}.tmp`)
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      await file.writeFile(text)
      await file.sync()
    } finally {
      await file.close()
    }
    await chmod(temporary, mode)
    if (!authorized()) throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
    // No async seam from comparison to rename. External edits observed here are rejected.
    if (readSettingsBytes(path, policy).revision !== revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    renameSync(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** Caller holds the file lock and patches the latest object, preserving unrelated keys. */
export async function saveSettingsFile(
  path: string,
  raw: Record<string, unknown>,
  revision: string,
  authorized: () => boolean,
  policy: SettingsFilePolicy,
): Promise<void> {
  await writeSettingsText(path, JSON.stringify(raw, null, 2) + '\n', revision, authorized, policy)
}
