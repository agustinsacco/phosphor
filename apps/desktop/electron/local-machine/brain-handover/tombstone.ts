/**
 * Fencing every Desktop build before the service may write: the original Brain file gets a
 * second name under `<userData>/brain-handover/<id>/original/` (never opened again), then one
 * rename puts a tombstone at the legacy path. Every engine refuses the tombstone's schema rather
 * than starting a new Brain there. Only a confirmed pre-commit abort renames the original back.
 */
import { randomUUID } from 'node:crypto'
import { emptyBrainDirectory, syncBrainPath } from '@phosphor/session-runtime/brain/local-owner'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { closeSync, constants, fsyncSync, openSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { brainTombstone, writeBrainTombstone } from '@phosphor/memory-engine/handover'
import { brainHandoverPaths, isBrainTombstoneFile } from '../../brain/owner-gate'

export class TombstoneRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TombstoneRefused'
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const walOf = (path: string) => `${path}-wal`

/** Same file under both names: the link already exists from an interrupted attempt. */
function sameInode(a: string, b: string): boolean {
  try {
    const x = statSync(a)
    const y = statSync(b)
    return x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

export function installBrainTombstone(
  userData: string,
  migrationId: string,
  Database: typeof DatabaseSync,
): void {
  const paths = brainHandoverPaths(userData, migrationId)
  if (isBrainTombstoneFile(paths.legacy)) return
  const wal = walOf(paths.legacy)
  if (existsSync(wal) && lstatSync(wal).size > 0)
    throw new TombstoneRefused('Brain is still writing. Try again.')
  mkdirSync(dirname(paths.original), { recursive: true, mode: 0o700 })
  if (!sameInode(paths.legacy, paths.original)) linkSync(paths.legacy, paths.original)
  syncDirectory(dirname(paths.original))
  const temp = join(dirname(paths.legacy), `.brain-moved-${migrationId}.sqlite`)
  rmSync(temp, { force: true })
  rmSync(walOf(temp), { force: true })
  writeBrainTombstone(Database, temp, migrationId)
  renameSync(temp, paths.legacy)
  syncDirectory(dirname(paths.legacy))
}

/** Puts the original back at the legacy path; only after the service confirmed it never published. */
export function restoreBrainOriginal(userData: string, migrationId: string): void {
  const paths = brainHandoverPaths(userData, migrationId)
  rmSync(join(dirname(paths.legacy), `.brain-moved-${migrationId}.sqlite`), { force: true })
  if (!existsSync(paths.original)) return
  if (sameInode(paths.legacy, paths.original)) rmSync(paths.original)
  else {
    renameSync(paths.original, paths.legacy)
    // The tombstone's WAL index must not outlive it.
    rmSync(`${paths.legacy}-shm`, { force: true })
  }
  syncDirectory(dirname(paths.legacy))
}

/** Fresh Host choice: an old Desktop must not create a second store. Never replace anything. */
export function fenceEmptyDesktopBrain(
  userData: string,
  Database: typeof DatabaseSync,
  fenceId: string,
): void {
  const { legacy, root } = brainHandoverPaths(userData)
  const directory = dirname(legacy)
  if (!emptyBrainDirectory(directory)) throw new TombstoneRefused('Desktop Brain is not empty.')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  syncDirectory(userData)
  // A killed process may leave a temp file behind. Keep it outside the legacy Brain folder.
  const temp = join(root, `.brain-first-owner-${randomUUID()}.sqlite`)
  try {
    writeBrainTombstone(Database, temp, fenceId)
    syncBrainPath(temp)
    linkSync(temp, legacy)
    syncDirectory(directory)
  } finally {
    rmSync(temp, { force: true })
    rmSync(walOf(temp), { force: true })
    rmSync(`${temp}-shm`, { force: true })
  }
}

/** Match only the intended tombstone, with no other legacy Brain entries or SQLite sidecars. */
export function matchesEmptyDesktopFence(
  userData: string,
  Database: typeof DatabaseSync,
  fenceId: string,
): boolean {
  const { legacy } = brainHandoverPaths(userData)
  const directory = dirname(legacy)
  if (!lstatSync(directory).isDirectory() || !isBrainTombstoneFile(legacy)) return false
  const entries = readdirSync(directory)
  if (entries.length !== 1 || entries[0] !== basename(legacy)) return false
  // Do not create SQLite sidecars on restart, or let a WAL supply the fence ID.
  const immutable = pathToFileURL(legacy)
  immutable.searchParams.set('immutable', '1')
  return brainTombstone(Database, immutable.href) === fenceId
}
