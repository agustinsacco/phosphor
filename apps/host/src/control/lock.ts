import { mkdir, open, link, lstat, rmdir, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { join } from 'node:path'
import { isIsoTime } from '@phosphor/shared/control-api'
import { checkIdentityDirectory, readIdentityFileSnapshot, IdentityFailure } from './identity'

export interface LockPorts {
  pid: number
  isAlive: (pid: number) => boolean
  link?: typeof link
  lstat?: (path: string) => Promise<Stats>
  wait?: (ms: number) => Promise<void>
  now?: () => number
}
export class LockBusy extends Error {
  constructor(pid?: number, message?: string) {
    super(
      message ??
        (pid === undefined
          ? 'Another phosphor login or logout is running.'
          : `Another phosphor login or logout is running (pid ${pid}).`),
    )
  }
}
const hasCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code
const defaultPorts: LockPorts = {
  pid: process.pid,
  isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (hasCode(error, 'EPERM')) return true
      if (hasCode(error, 'ESRCH')) return false
      throw new IdentityFailure('Could not check the identity lock.')
    }
  },
}
function parseLock(text: string): { pid: number; token: string } | null {
  try {
    const value: unknown = JSON.parse(text)
    if (
      value !== null &&
      typeof value === 'object' &&
      'pid' in value &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.pid <= 2147483647 &&
      'token' in value &&
      typeof value.token === 'string' &&
      /^[0-9a-f]{64}$/.test(value.token) &&
      'startedAt' in value &&
      isIsoTime(value.startedAt)
    )
      return { pid: value.pid, token: value.token }
  } catch {
    /* Malformed locks can be recovered. */
  }
  return null
}

export async function acquireIdentityLock(
  directory: string,
  uid: number | undefined,
  ports: LockPorts = defaultPorts,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await checkIdentityDirectory(directory, uid)
  const path = join(directory, '.lock')
  const gatePath = join(directory, '.lock-recovery')
  const token = randomBytes(32).toString('hex')
  const temp = join(directory, `.lock.${token}.tmp`)
  // Only the process whose mkdir created the gate ever removes it. A gate is held
  // for milliseconds, so one left behind means a crash inside it: the user removes
  // it. Clearing it automatically on age could remove a live gate (review r2).
  async function gate() {
    for (let attempt = 0; attempt <= 20; attempt++) {
      try {
        await mkdir(gatePath, { mode: 0o700 })
        return
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
      }
      if (attempt === 20) break
      await (ports.wait ?? ((ms) => setTimeout(ms)))(50)
    }
    let info
    try {
      info = await lstat(gatePath)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) throw new LockBusy()
      throw error
    }
    if ((ports.now ?? Date.now)() - info.mtimeMs > 30_000)
      throw new LockBusy(
        undefined,
        'A crashed phosphor login or logout left identity/.lock-recovery. If none is running, remove it and retry.',
      )
    throw new LockBusy()
  }
  async function snapshot() {
    try {
      let info = await (ports.lstat ?? lstat)(path)
      if (info.isDirectory())
        throw new LockBusy(
          undefined,
          'Remove the directory identity/.lock, then retry phosphor login or logout.',
        )
      let lock = null
      try {
        const read = await readIdentityFileSnapshot(directory, uid, '.lock')
        lock = parseLock(read.text)
        if (lock) info = read.info
      } catch {
        /* Invalid locks are recoverable. */
      }
      return { info, lock }
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null
      throw error
    }
  }
  const existing = await snapshot()
  if (existing?.lock && ports.isAlive(existing.lock.pid)) throw new LockBusy(existing.lock.pid)
  const file = await open(temp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(
        JSON.stringify({ pid: ports.pid, token, startedAt: new Date().toISOString() }) + '\n',
      )
      await file.sync()
    } finally {
      await file.close()
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await (ports.link ?? link)(temp, path)
        break
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
        const stale = await snapshot()
        if (stale?.lock && ports.isAlive(stale.lock.pid)) throw new LockBusy(stale.lock.pid)
        if (attempt === 1) throw new LockBusy()
        await gate()
        try {
          const current = await snapshot()
          // The inode also identifies unreadable or invalid locks. A replacement is never reclaimed.
          if (
            current &&
            stale &&
            current.info.dev === stale.info.dev &&
            current.info.ino === stale.info.ino &&
            current.lock?.token === stale.lock?.token &&
            (!current.lock || !ports.isAlive(current.lock.pid))
          )
            await unlink(path)
        } finally {
          await rmdir(gatePath)
        }
      }
    }
  } finally {
    await unlink(temp)
  }
  return async () => {
    await gate()
    try {
      const current = await snapshot()
      if (current?.lock?.token !== token) return
      await unlink(path)
    } finally {
      await rmdir(gatePath)
    }
  }
}
