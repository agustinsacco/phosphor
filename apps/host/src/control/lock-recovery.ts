import { mkdir, lstat, rmdir, unlink, type link } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { isIsoTime } from '@phosphor/shared/control-api'
import { errnoIs } from '../fs-safety'
import { readIdentityFileSnapshot } from './identity'

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

export interface LockState {
  path: string
  gatePath: string
  token: string
  name: '.lock' | '.run-lock'
  directory: string
  uid: number | undefined
  ports: LockPorts
}

export function lockBusy({ name }: LockState, pid?: number, message?: string): LockBusy {
  return new LockBusy(
    pid,
    name === '.lock'
      ? message
      : (message?.replaceAll('login or logout', 'run').replaceAll('.lock', name) ??
          `Another phosphor run is running${pid === undefined ? '.' : ` (pid ${pid}).`}`),
  )
}

export function parseLock(text: string): { pid: number; token: string } | null {
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

// Only the process whose mkdir created the gate ever removes it. A gate is held
// for milliseconds, so one left behind means a crash inside it: the user removes
// it. Clearing it automatically on age could remove a live gate (review r2).
export async function acquireRecoveryGate(state: LockState): Promise<void> {
  const { gatePath, ports } = state
  for (let attempt = 0; attempt <= 20; attempt++) {
    try {
      await mkdir(gatePath, { mode: 0o700 })
      return
    } catch (error) {
      if (!(error instanceof Error && errnoIs(error, 'EEXIST'))) throw error
    }
    if (attempt === 20) break
    await (ports.wait ?? ((ms) => setTimeout(ms)))(50)
  }
  let info
  try {
    info = await lstat(gatePath)
  } catch (error) {
    if (error instanceof Error && errnoIs(error, 'ENOENT')) throw lockBusy(state)
    throw error
  }
  if ((ports.now ?? Date.now)() - info.mtimeMs > 30_000)
    throw lockBusy(
      state,
      undefined,
      'A crashed phosphor login or logout left identity/.lock-recovery. If none is running, remove it and retry.',
    )
  throw lockBusy(state)
}

export interface LockSnapshot {
  info: Stats
  lock: ReturnType<typeof parseLock>
}

export async function snapshotLock(state: LockState): Promise<LockSnapshot | null> {
  const { path, directory, uid, name, ports } = state
  try {
    let info = await (ports.lstat ?? lstat)(path)
    if (info.isDirectory())
      throw lockBusy(
        state,
        undefined,
        'Remove the directory identity/.lock, then retry phosphor login or logout.',
      )
    let lock = null
    try {
      const read = await readIdentityFileSnapshot(directory, uid, name)
      lock = parseLock(read.text)
      if (lock) info = read.info
    } catch {
      /* Invalid locks are recoverable. */
    }
    return { info, lock }
  } catch (error) {
    if (error instanceof Error && errnoIs(error, 'ENOENT')) return null
    throw error
  }
}

export async function reclaimLock(state: LockState, stale: LockSnapshot | null): Promise<void> {
  await acquireRecoveryGate(state)
  try {
    const current = await snapshotLock(state)
    // The inode also identifies unreadable or invalid locks. A replacement is never reclaimed.
    if (
      current &&
      stale &&
      current.info.dev === stale.info.dev &&
      current.info.ino === stale.info.ino &&
      current.lock?.token === stale.lock?.token &&
      (!current.lock || !state.ports.isAlive(current.lock.pid))
    )
      await unlink(state.path)
  } finally {
    await rmdir(state.gatePath)
  }
}

export async function releaseIdentityLock(state: LockState): Promise<void> {
  await acquireRecoveryGate(state)
  try {
    const current = await snapshotLock(state)
    if (current?.lock?.token !== state.token) return
    await unlink(state.path)
  } finally {
    await rmdir(state.gatePath)
  }
}
