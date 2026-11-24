import { lstatSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { errnoIs } from '../fs-safety'

/**
 * Retirement for the install lock shared with the generated installer
 * (docs/host.md, Install). A lock is never deleted in place: it is renamed to
 * this process's retired name, then its known contents and the folder are
 * removed, so a new owner who takes the lock path meanwhile keeps its lock.
 */

/** Answers whether the process with this pid is gone. */
export type DeadPid = (pid: number) => boolean

/** The install lock and the name this process retires a lock to. */
export interface InstallLockPaths {
  readonly lib: string
  readonly lock: string
  readonly retired: string
}

/** Acquisition examines at most this many retired folders. */
const RETIRED_SWEEP_LIMIT = 16

export function installLockPaths(lib: string, pid = process.pid): InstallLockPaths {
  const lock = join(lib, '.install-lock')
  return { lib, lock, retired: join(lib, `.install-lock.retired.${pid}`) }
}

/** Every refusal names the lock path, whichever step refused. */
export function refuseInstallLock(paths: InstallLockPaths): never {
  throw new Error(`Install lock: ${paths.lock}. Remove it only if no install or update is running.`)
}

const missing = (error: unknown) => error instanceof Error && errnoIs(error, 'ENOENT')

/** The pid of an exact retired folder name: one to ten digits, no leading zero. */
export function retiredLockPid(name: string): number | undefined {
  const match = /^\.install-lock\.retired\.([1-9][0-9]{0,9})$/.exec(name)
  return match?.[1] ? Number(match[1]) : undefined
}

/**
 * Delete a retired folder's known contents (`pid`, `recovery/`), then the
 * folder. A linked gate is refused; any other content fails the rmdir.
 */
export function removeRetiredLock(paths: InstallLockPaths, path = paths.retired): void {
  try {
    unlinkSync(join(path, 'pid'))
  } catch (error) {
    if (!missing(error)) throw error
  }
  try {
    if (lstatSync(join(path, 'recovery')).isSymbolicLink()) refuseInstallLock(paths)
    rmdirSync(join(path, 'recovery'))
  } catch (error) {
    if (!missing(error)) throw error
  }
  rmdirSync(path)
}

/** Rename the lock to this process's retired name, refusing if anything holds that name. */
export function renameToRetired(paths: InstallLockPaths): void {
  try {
    lstatSync(paths.retired)
    refuseInstallLock(paths)
  } catch (error) {
    if (!missing(error)) throw error
  }
  renameSync(paths.lock, paths.retired)
}

/** Release a lock this process owns: rename it away, then remove the retired folder. */
export function retireInstallLock(paths: InstallLockPaths): void {
  renameToRetired(paths)
  removeRetiredLock(paths)
}

/**
 * Remove the retired folders of dead owners. Only exact, non-symlink folders
 * count; the first 16 are examined, live or dead, and the rest wait.
 */
export function sweepRetiredLocks(paths: InstallLockPaths, dead: DeadPid): void {
  let swept = 0
  for (const name of readdirSync(paths.lib)) {
    const pid = retiredLockPid(name)
    if (pid === undefined) continue
    const path = join(paths.lib, name)
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    if (++swept > RETIRED_SWEEP_LIMIT) break
    if (dead(pid)) removeRetiredLock(paths, path)
  }
}
