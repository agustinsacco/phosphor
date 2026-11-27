import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isIsoTime } from '@phosphor/shared/control-api'
import { OWNER_LOCK_FILE } from '@phosphor/shared/host-local'
import { errnoIs, isOwnerPrivate } from '../fs-safety'
import {
  publishLinkLock,
  releaseLinkLock,
  type LinkLock,
  type LinkLockPorts,
  type LinkLockRefusal,
} from './link-lock'
import { readProcessStart } from './process-start'
import {
  OwnerLockBusy,
  type OwnerLockHolder,
  type OwnerLockPorts,
  type OwnerLockRecord,
} from './types'

/**
 * The machine-wide owner lock in pi's agent folder. It is published and
 * recovered by the shared link-lock core, so it works across processes:
 * Desktop and the daemon each acquire it before running lanes. A holder is
 * stale when its pid is dead, or alive with a different start time; a live
 * holder is never removed.
 */

export type OwnerLockUnavailableReason = 'contended' | 'gate-stuck' | 'directory' | 'folder'

/** The lock could not be taken for a reason other than a live holder. */
export class OwnerLockUnavailable extends Error {
  readonly reason: OwnerLockUnavailableReason

  constructor(reason: OwnerLockUnavailableReason, message: string) {
    super(message)
    this.name = 'OwnerLockUnavailable'
    this.reason = reason
  }
}

export interface OwnerLock {
  readonly record: OwnerLockRecord
  /** Remove the lock if it still carries this acquirer's token. */
  release(): Promise<void>
}

export interface AcquireOwnerLockOptions extends LinkLockPorts {
  /** Recorded for people reading the lock. Default: the process title. */
  readonly program?: string
  /** The user that must own the agent folder and the lock. Default: this process's uid. */
  readonly uid?: number
}

const MAX_LOCK_BYTES = 4_096
const MAX_TEXT_LENGTH = 256

export const ownerLockPorts: OwnerLockPorts = {
  pid: process.pid,
  isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (errnoIs(error, 'EPERM')) return true
      if (errnoIs(error, 'ESRCH')) return false
      throw new Error('Could not check the owner lock holder.', { cause: error })
    }
  },
  processStart: (pid) => readProcessStart(pid),
}

/**
 * Live when the pid is alive and, if both start times are known, they match.
 * An unknown start time cannot prove reuse, so liveness alone decides.
 */
export async function isOwnerLockHolderLive(
  holder: Pick<OwnerLockRecord, 'pid' | 'processStart'>,
  ports: OwnerLockPorts = ownerLockPorts,
): Promise<boolean> {
  if (!ports.isAlive(holder.pid)) return false
  if (holder.processStart === null) return true
  const current = await ports.processStart(holder.pid)
  return current === null || current === holder.processStart
}

const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH

export function parseOwnerLockRecord(text: string): OwnerLockRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (
    v.version !== 1 ||
    (v.owner !== 'desktop' && v.owner !== 'daemon') ||
    typeof v.pid !== 'number' ||
    !Number.isSafeInteger(v.pid) ||
    v.pid <= 0 ||
    v.pid > 2147483647 ||
    (v.processStart !== null && !boundedText(v.processStart)) ||
    typeof v.token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(v.token) ||
    !isIsoTime(v.startedAt) ||
    !boundedText(v.program)
  )
    return null
  return {
    version: 1,
    owner: v.owner,
    pid: v.pid,
    processStart: v.processStart,
    token: v.token,
    startedAt: v.startedAt,
    program: v.program,
  }
}

/** Read through a descriptor that refuses symlinks; only a private file of `uid` counts. */
export async function readPrivateLockFile(
  path: string,
  uid: number | undefined,
): Promise<{ text: string; info: Stats }> {
  const invalid = () => new Error('The owner lock is not a private file of this user.')
  const info = await lstat(path)
  if (!info.isFile() || !privateTo(info, uid)) throw invalid()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const actual = await file.stat()
    if (!actual.isFile() || !privateTo(actual, uid) || actual.size > MAX_LOCK_BYTES) throw invalid()
    const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_LOCK_BYTES) throw invalid()
    return { text: bytes.subarray(0, bytesRead).toString('utf8'), info: actual }
  } finally {
    await file.close()
  }
}

// Without a uid (Windows) ownership cannot be proved, so only the mode is checked.
const privateTo = (info: Stats, uid: number | undefined) =>
  uid === undefined ? (info.mode & 0o077) === 0 : isOwnerPrivate(info, uid)

function refuseOwnerLock(
  path: string,
  gatePath: string,
  refusal: LinkLockRefusal<OwnerLockRecord>,
): Error {
  switch (refusal.kind) {
    case 'held':
      return new OwnerLockBusy(refusal.holder)
    case 'contended':
      return new OwnerLockUnavailable(
        'contended',
        `Another Phosphor process is taking ${path}. Retry in a moment.`,
      )
    case 'gate-stuck':
      return new OwnerLockUnavailable(
        'gate-stuck',
        `A crashed Phosphor process left ${gatePath}. If no Phosphor is starting, remove it and retry.`,
      )
    case 'directory':
      return new OwnerLockUnavailable(
        'directory',
        `Remove the folder ${path}, then start Phosphor again.`,
      )
  }
}

/** pi's agent folder must be a folder this user owns; its mode is pi's business. */
async function checkAgentFolder(agentDir: string, uid: number | undefined): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 })
  const info = await stat(agentDir)
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid))
    throw new OwnerLockUnavailable(
      'folder',
      `pi's agent folder ${agentDir} is not a folder this user owns.`,
    )
}

/** The lock's current holder as written, or null when there is none or it is invalid. Liveness is not checked. */
export async function readOwnerLock(
  agentDir: string,
  uid: number | undefined = process.getuid?.(),
): Promise<OwnerLockRecord | null> {
  try {
    return parseOwnerLockRecord(
      (await readPrivateLockFile(join(agentDir, OWNER_LOCK_FILE), uid)).text,
    )
  } catch {
    return null
  }
}

/**
 * Take the owner lock for `owner`. Refuses with `OwnerLockBusy` while a live
 * process holds it, whichever role that is, and with `OwnerLockUnavailable`
 * when the folder or the recovery gate is in the way.
 */
export async function acquireOwnerLock(
  agentDir: string,
  owner: OwnerLockHolder,
  ports: OwnerLockPorts = ownerLockPorts,
  options: AcquireOwnerLockOptions = {},
): Promise<OwnerLock> {
  const { program = process.title, uid = process.getuid?.(), ...linkPorts } = options
  await checkAgentFolder(agentDir, uid)
  const path = join(agentDir, OWNER_LOCK_FILE)
  const gatePath = `${path}-recovery`
  const token = randomBytes(32).toString('hex')
  const lock: LinkLock<OwnerLockRecord> = {
    path,
    gatePath,
    token,
    ports: linkPorts,
    read: () => readPrivateLockFile(path, uid),
    parse: parseOwnerLockRecord,
    isLive: (holder) => isOwnerLockHolderLive(holder, ports),
    refuse: (refusal) => refuseOwnerLock(path, gatePath, refusal),
  }
  // A start time the parser would refuse is recorded as unknown, never as a
  // lock that reads invalid and so could be reclaimed from a live holder.
  const processStart = await ports.processStart(ports.pid)
  const record: OwnerLockRecord = {
    version: 1,
    owner,
    pid: ports.pid,
    processStart: boundedText(processStart) ? processStart : null,
    token,
    startedAt: new Date().toISOString(),
    program: program.slice(0, MAX_TEXT_LENGTH) || 'phosphor',
  }
  await publishLinkLock(lock, `${path}.${token}.tmp`, JSON.stringify(record) + '\n')
  return { record, release: () => releaseLinkLock(lock) }
}
