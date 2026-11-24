import { lstatSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errnoIs } from '../fs-safety'
import {
  type DeadPid,
  installLockPaths,
  refuseInstallLock,
  removeRetiredLock,
  renameToRetired,
  retireInstallLock,
  sweepRetiredLocks,
} from './lock-retirement'

/** Compatibility facade for update and uninstall: only an Error carrying `code` matches. */
export const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && errnoIs(error, code)
export function deadPid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && errnoIs(error, 'ESRCH')
  }
}
export function acquireInstallLock(lib: string, dead: DeadPid = deadPid): () => void {
  const paths = installLockPaths(lib)
  const { lock } = paths
  const refuse = (): never => refuseInstallLock(paths)
  const owner = () => {
    const file = join(lock, 'pid')
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20) refuse()
    const text = readFileSync(file, 'utf8')
    if (!/^[1-9][0-9]{0,9}\n$/.test(text)) refuse()
    return Number(text.trim())
  }
  sweepRetiredLocks(paths, dead)
  try {
    mkdirSync(lock)
  } catch (error) {
    if (!(error instanceof Error && errnoIs(error, 'EEXIST'))) throw error
    let gate = false
    try {
      const info = lstatSync(lock)
      if (!info.isDirectory() || info.isSymbolicLink()) refuse()
      const pid = owner()
      if (!dead(pid)) refuse()
      mkdirSync(join(lock, 'recovery'))
      gate = true
      if (owner() !== pid || !dead(pid)) refuse()
      renameToRetired(paths)
      gate = false
      removeRetiredLock(paths)
      mkdirSync(lock)
    } catch {
      if (gate) rmdirSync(join(lock, 'recovery'))
      refuse()
    }
  }
  try {
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    retireInstallLock(paths)
    throw error
  }
  return () => retireInstallLock(paths)
}
