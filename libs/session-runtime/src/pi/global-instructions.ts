import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  GLOBAL_INSTRUCTIONS_DEFAULT,
  GLOBAL_INSTRUCTIONS_MAX_BYTES,
  GLOBAL_INSTRUCTIONS_NAMES,
  isGlobalInstructionsText,
  type GlobalInstructions,
} from '@phosphor/shared/global-instructions'

/**
 * Reads and saves the global context file pi loads from its agent directory,
 * for the Settings editor on Desktop and on a Host. See
 * `libs/shared/src/global-instructions.ts` for what the file is.
 *
 * The editor edits the file pi actually loads (an `AGENTS.override.md` or a
 * `CLAUDE.md` there included), and creates `AGENTS.md` only when there is
 * none: creating one beside a `CLAUDE.md` would silently replace it.
 *
 * A save names the revision it was opened at and is refused when the file
 * changed since, checked again just before the atomic rename. Synchronous on
 * purpose, so nothing in this process interleaves a check and its write.
 */

export type GlobalInstructionsFailure = 'conflict' | 'unsafe' | 'invalid'

export class GlobalInstructionsError extends Error {
  constructor(
    readonly code: GlobalInstructionsFailure,
    message: string,
  ) {
    super(message)
  }
}

export interface GlobalInstructionsPolicy {
  /**
   * Follow a file that is a symbolic link, and save through it so the link
   * survives (Desktop: dotfiles). A Host refuses links, unowned files and
   * world-writable ones, as it does for every config file it edits.
   */
  followLinks: boolean
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** The file pi loads from `agentDir` now, or where Settings would create one. */
export function globalInstructionsPath(agentDir: string): { path: string; exists: boolean } {
  for (const name of GLOBAL_INSTRUCTIONS_NAMES) {
    const path = join(agentDir, name)
    try {
      if (statSync(path).isFile()) return { path, exists: true }
    } catch {
      // Missing or unreadable: pi moves on to the next name too.
    }
  }
  return { path: join(agentDir, GLOBAL_INSTRUCTIONS_DEFAULT), exists: false }
}

const owned = (uid: number): boolean => !process.getuid || uid === process.getuid()

function readBytes(path: string, policy: GlobalInstructionsPolicy): Buffer {
  let fd: number
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (policy.followLinks ? 0 : constants.O_NOFOLLOW),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new GlobalInstructionsError(
        'unsafe',
        `${basename(path)} is a link. Edit it on the machine.`,
      )
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new GlobalInstructionsError('unsafe', `${path} is not a file.`)
    if (!policy.followLinks && (stat.nlink !== 1 || (stat.mode & 0o002) !== 0 || !owned(stat.uid)))
      throw new GlobalInstructionsError(
        'unsafe',
        `${basename(path)} must be an owned regular file, not a link or world-writable file.`,
      )
    const bounded = Buffer.alloc(GLOBAL_INSTRUCTIONS_MAX_BYTES + 1)
    let count = 0
    while (count < bounded.length) {
      const read = readSync(fd, bounded, count, bounded.length - count, count)
      if (!read) break
      count += read
    }
    if (count > GLOBAL_INSTRUCTIONS_MAX_BYTES)
      throw new GlobalInstructionsError(
        'invalid',
        `${basename(path)} is larger than ${GLOBAL_INSTRUCTIONS_MAX_BYTES / 1024} KiB. Edit it on the machine.`,
      )
    return bounded.subarray(0, count)
  } finally {
    closeSync(fd)
  }
}

export function readGlobalInstructions(
  agentDir: string,
  policy: GlobalInstructionsPolicy,
): GlobalInstructions {
  const { path, exists } = globalInstructionsPath(agentDir)
  if (!exists) return { path, content: '', revision: sha256(''), exists: false }
  const bytes = readBytes(path, policy)
  const content = bytes.toString('utf8')
  if (content.includes('\0'))
    throw new GlobalInstructionsError('invalid', `${basename(path)} is not a text file.`)
  return { path, content, revision: sha256(bytes), exists: true }
}

function safeParent(parent: string, policy: GlobalInstructionsPolicy): void {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (policy.followLinks) return
  const directory = lstatSync(parent)
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o002) !== 0 ||
    !owned(directory.uid)
  )
    throw new GlobalInstructionsError('unsafe', 'The pi agent folder is not safe to modify.')
}

const CHANGED = 'The file changed on disk since it was opened. Reload it before saving.'

/** Save `content` over the file read at `revision`; returns the file as saved. */
export function writeGlobalInstructions(
  agentDir: string,
  content: string,
  revision: string,
  policy: GlobalInstructionsPolicy,
  authorized: () => boolean = () => true,
): GlobalInstructions {
  if (!isGlobalInstructionsText(content))
    throw new GlobalInstructionsError(
      'invalid',
      `Instructions must be text under ${GLOBAL_INSTRUCTIONS_MAX_BYTES / 1024} KiB.`,
    )
  const current = readGlobalInstructions(agentDir, policy)
  if (current.revision !== revision) throw new GlobalInstructionsError('conflict', CHANGED)
  // Through a link, replace the file it names so the link itself survives.
  const target =
    current.exists && policy.followLinks ? realpathSync.native(current.path) : current.path
  const parent = dirname(target)
  safeParent(parent, policy)
  const mode = current.exists ? statSync(target).mode & 0o777 : 0o644
  const temporary = join(parent, `.${basename(target)}-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      writeSync(fd, Buffer.from(content, 'utf8'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temporary, mode)
    if (!authorized())
      throw new GlobalInstructionsError('unsafe', 'Configuration access was revoked.')
    // No await between this check and the rename.
    if (readGlobalInstructions(agentDir, policy).revision !== revision)
      throw new GlobalInstructionsError('conflict', CHANGED)
    renameSync(temporary, target)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Renamed into place, or never created.
    }
  }
  return readGlobalInstructions(agentDir, policy)
}

/**
 * Append text to the end of the file, creating it when there is none. For
 * moving instructions Phosphor used to keep in its own settings.
 */
export function appendGlobalInstructions(
  agentDir: string,
  text: string,
  policy: GlobalInstructionsPolicy,
): GlobalInstructions {
  const current = readGlobalInstructions(agentDir, policy)
  const body = current.content.replace(/\s+$/, '')
  const next = `${body ? `${body}\n\n` : ''}${text.trim()}\n`
  return writeGlobalInstructions(agentDir, next, current.revision, policy)
}
