import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { syncBrainPath } from '@phosphor/session-runtime/brain/local-owner'
import { errnoIs, isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { readBounded } from '@phosphor/session-runtime/host-install/files'
import { isUuid } from '@phosphor/shared/control-api'
import { brainHandoverPaths } from '../../brain/owner-gate'

const FILE = 'first-owner.json'

export interface FirstOwnerIntent {
  readonly version: 1
  readonly fenceId: string
  readonly machineId: string
  readonly stateDir: string
}

export function readFirstOwnerIntent(userData: string): FirstOwnerIntent | 'blocked' | null {
  const { root } = brainHandoverPaths(userData)
  const path = join(root, FILE)
  try {
    const parent = lstatSync(root)
    if (!parent.isDirectory()) return 'blocked'
    const info = lstatSync(path)
    if (!info.isFile() || !isOwnerPrivate(info, process.getuid?.())) return 'blocked'
    const value = JSON.parse(readBounded(path, 32 * 1024)) as Partial<FirstOwnerIntent> | null
    return value?.version === 1 &&
      isUuid(value.fenceId) &&
      isUuid(value.machineId) &&
      typeof value.stateDir === 'string' &&
      isAbsolute(value.stateDir)
      ? (value as FirstOwnerIntent)
      : 'blocked'
  } catch (error) {
    return errnoIs(error, 'ENOENT') ? null : 'blocked'
  }
}

/** Put the intent on disk before linking its fence. A competing intent is never overwritten. */
export function writeFirstOwnerIntent(
  userData: string,
  machineId: string,
  stateDir: string,
): FirstOwnerIntent {
  const { root } = brainHandoverPaths(userData)
  const intent: FirstOwnerIntent = { version: 1, fenceId: randomUUID(), machineId, stateDir }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const temp = join(root, `.first-owner-${intent.fenceId}`)
  try {
    writeFileSync(temp, JSON.stringify(intent) + '\n', { mode: 0o600, flag: 'wx' })
    syncBrainPath(temp)
    linkSync(temp, join(root, FILE))
    syncBrainPath(root)
    syncBrainPath(userData)
    return intent
  } finally {
    rmSync(temp, { force: true })
  }
}
