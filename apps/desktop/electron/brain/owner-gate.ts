/**
 * Who may write This Mac's Desktop Brain (docs/brain-handover.md). A move to the local Phosphor
 * service records its phase in `<userData>/brain-handover/state.json` before each step, so the
 * gate answers from durable state, never from a folder's contents or a lost connection:
 *
 * - `desktop`: no move, or one that aborted before the service published it.
 * - `moving`: a move is under way or its outcome is not yet known; nothing may write.
 * - `host`: the service owns the Brain; Desktop never serves its pre-move copy again.
 *
 * A tombstone at `<userData>/brain/brain.sqlite` with no record also answers `moving`.
 */
import { readLocalBrainSelection } from '@phosphor/session-runtime/brain/local-owner'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const BRAIN_HANDOVER_DIRECTORY = 'brain-handover'
/** memory-engine's BRAIN_TOMBSTONE_VERSION, read from the file header without SQLite. */
const TOMBSTONE_VERSION = 1_000_000

export type DesktopBrainOwner = 'desktop' | 'moving' | 'host'

/**
 * `fenced`: writers stopped, the service may be staging or verifying.
 * `tombstoned`: the legacy file is (or is about to be) a tombstone; the service may commit.
 */
export type DesktopBrainHandoverPhase = 'fenced' | 'tombstoned' | 'committed' | 'aborted'

export interface DesktopBrainHandoverRecord {
  readonly version: 1
  readonly migrationId: string
  readonly phase: DesktopBrainHandoverPhase
}

export class BrainOwnerMoved extends Error {
  constructor(readonly owner: Exclude<DesktopBrainOwner, 'desktop'>) {
    super(
      owner === 'host'
        ? 'Brain runs on the Phosphor service on this Mac.'
        : 'Brain is moving to the Phosphor service on this Mac.',
    )
    this.name = 'BrainOwnerMoved'
  }
}

export function brainHandoverPaths(userData: string, migrationId = '') {
  const root = join(userData, BRAIN_HANDOVER_DIRECTORY)
  return {
    root,
    record: join(root, 'state.json'),
    legacy: join(userData, 'brain', 'brain.sqlite'),
    move: join(root, migrationId),
    /** A second name for the original file; nothing writes through it. */
    original: join(root, migrationId, 'original', 'brain.sqlite'),
  }
}

export function readBrainHandoverRecord(userData: string): DesktopBrainHandoverRecord | null {
  let text: string
  try {
    text = readFileSync(brainHandoverPaths(userData).record, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const value = JSON.parse(text) as Partial<DesktopBrainHandoverRecord>
  const phases: readonly string[] = ['fenced', 'tombstoned', 'committed', 'aborted']
  if (
    value.version !== 1 ||
    typeof value.migrationId !== 'string' ||
    !phases.includes(value.phase!)
  )
    throw new Error('Unreadable Brain handover record.')
  return value as DesktopBrainHandoverRecord
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Temp file, fsync, rename, folder fsync: a crash leaves the old record or the new one. */
export function writeBrainHandoverRecord(
  userData: string,
  record: DesktopBrainHandoverRecord,
): void {
  const path = brainHandoverPaths(userData).record
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.state-${randomUUID()}`)
  try {
    writeFileSync(temp, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' })
    const fd = openSync(temp, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    syncDirectory(dirname(path))
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Whether the file at `path` is a SQLite database whose `user_version` is the tombstone's. */
export function isBrainTombstoneFile(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return false
  }
  try {
    if (!fstatSync(fd).isFile()) return false
    const header = Buffer.alloc(100)
    if (readSync(fd, header, 0, 100, 0) < 100) return false
    if (header.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') return false
    return header.readInt32BE(60) === TOMBSTONE_VERSION
  } finally {
    closeSync(fd)
  }
}

export function desktopBrainOwner(userData: string): DesktopBrainOwner {
  let record: DesktopBrainHandoverRecord | null
  try {
    record = readBrainHandoverRecord(userData)
  } catch {
    return 'moving'
  }
  if (record?.phase === 'committed') return 'host'
  if (record?.phase === 'fenced' || record?.phase === 'tombstoned') return 'moving'
  return isBrainTombstoneFile(brainHandoverPaths(userData).legacy) ? 'moving' : 'desktop'
}

/** Throws unless Desktop may open and write its own Brain. */
export function requireDesktopBrainOwner(userData: string): void {
  const owner = desktopBrainOwner(userData)
  if (owner !== 'desktop') throw new BrainOwnerMoved(owner)
}

/** The launch fence starts closed, including when the owner socket connects before launch. */
let launched: { userData: string; owner: DesktopBrainOwner; stateDir?: string } | undefined

export function finishBrainOwnerLaunch(
  userData: string,
  owner: DesktopBrainOwner,
  stateDir?: string,
): void {
  if (launched) throw new Error('This Mac’s Brain owner is decided once per launch.')
  launched = { userData, owner, stateDir }
}

export function launchedBrainOwner(userData: string): DesktopBrainOwner {
  if (launched?.userData !== userData) return 'moving'
  if (launched.owner !== 'desktop') return launched.owner
  const owner = desktopBrainOwner(userData)
  if (owner !== 'desktop' || !launched.stateDir) return owner
  const selection = readLocalBrainSelection(launched.stateDir)
  return selection === 'host' || selection === 'blocked' ? 'moving' : 'desktop'
}

export function requireLaunchedDesktopBrain(userData: string): void {
  const owner = launchedBrainOwner(userData)
  if (owner !== 'desktop') throw new BrainOwnerMoved(owner)
}

export function launchedDesktopOwnsBrain(): boolean {
  return launched !== undefined && launchedBrainOwner(launched.userData) === 'desktop'
}
