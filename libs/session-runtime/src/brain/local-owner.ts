import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { errnoIs, isOwnerPrivate } from '../fs-safety'
import { readBounded } from '../host-install/files'

export type LocalBrainSelection = 'desktop' | 'host'
export const LOCAL_BRAIN_OWNER_FILE = 'brain-owner.json'
const record = (stateDir: string) => join(stateDir, LOCAL_BRAIN_OWNER_FILE)
const encoded = (owner: LocalBrainSelection) => JSON.stringify({ version: 1, owner }) + '\n'

export function readLocalBrainSelection(
  stateDir: string,
  uid = process.getuid?.(),
): LocalBrainSelection | 'unset' | 'blocked' {
  try {
    const parent = lstatSync(stateDir)
    if (!parent.isDirectory() || !isOwnerPrivate(parent, uid)) return 'blocked'
    const path = record(stateDir)
    const info = lstatSync(path)
    if (!info.isFile() || !isOwnerPrivate(info, uid)) return 'blocked'
    const data = readBounded(path, 128)
    if (data === encoded('desktop')) return 'desktop'
    if (data === encoded('host')) return 'host'
    return 'blocked'
  } catch (error) {
    return errnoIs(error, 'ENOENT') ? 'unset' : 'blocked'
  }
}

export function syncBrainPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** A complete, durable record or the competing record: never truncate, replace, or retry it. */
export function selectLocalBrainOwner(stateDir: string, owner: LocalBrainSelection): boolean {
  const path = record(stateDir)
  const current = readLocalBrainSelection(stateDir)
  if (current !== 'unset') return current === owner
  const temp = join(dirname(path), `.brain-owner-${randomUUID()}`)
  try {
    writeFileSync(temp, encoded(owner), { flag: 'wx', mode: 0o600 })
    syncBrainPath(temp)
    try {
      linkSync(temp, path)
    } catch (error) {
      if (!errnoIs(error, 'EEXIST')) throw error
    }
    syncBrainPath(stateDir)
    return readLocalBrainSelection(stateDir) === owner
  } finally {
    rmSync(temp, { force: true })
  }
}

/** A wrong file type, inaccessible folder, or any entry is not proof of emptiness. */
export function emptyBrainDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && readdirSync(path).length === 0
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return true
    throw error
  }
}
