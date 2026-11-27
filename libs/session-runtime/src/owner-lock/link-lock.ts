import { link, lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { errnoIs } from '../fs-safety'

/**
 * A lock file published by hard link: a complete, synced temporary file is
 * linked into place, so a reader never sees a partial lock. A holder that is
 * no longer live is reclaimed under a `mkdir` gate that compares the file's
 * identity and token again, so a replacement is never removed. The Host's
 * identity locks and the owner lock share this core; each supplies its own
 * reader, record parser, liveness rule and refusal errors.
 */

export interface LinkLockPorts {
  link?: typeof link
  lstat?: (path: string) => Promise<Stats>
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

export interface LinkLockHolder {
  readonly pid: number
  readonly token: string
}

export type LinkLockRefusal<T> =
  /** A live process holds the lock. */
  | { readonly kind: 'held'; readonly holder: T }
  /** Another process won the lock or holds the recovery gate. */
  | { readonly kind: 'contended' }
  /** The recovery gate is over 30 seconds old: possibly left by a crash, never removed automatically. */
  | { readonly kind: 'gate-stuck' }
  /** A directory sits at the lock path. */
  | { readonly kind: 'directory' }

export interface LinkLock<T extends LinkLockHolder> {
  readonly path: string
  readonly gatePath: string
  /** This acquirer's token; release removes only a lock carrying it. */
  readonly token: string
  readonly ports: LinkLockPorts
  /** Read the lock through a safe descriptor. A throw makes the lock invalid, and so recoverable. */
  read(): Promise<{ text: string; info: Stats }>
  parse(text: string): T | null
  isLive(holder: T): boolean | Promise<boolean>
  refuse(refusal: LinkLockRefusal<T>): Error
}

export interface LinkLockSnapshot<T> {
  info: Stats
  lock: T | null
}

const GATE_ATTEMPTS = 20
const GATE_WAIT_MS = 50
const GATE_STUCK_MS = 30_000

// Only the process whose mkdir created the gate ever removes it. A gate is held
// for milliseconds, so one left behind means a crash inside it: the user removes
// it. Clearing it automatically on age could remove a live gate (review r2).
export async function acquireRecoveryGate<T extends LinkLockHolder>(
  lock: LinkLock<T>,
): Promise<void> {
  const { gatePath, ports } = lock
  for (let attempt = 0; attempt <= GATE_ATTEMPTS; attempt++) {
    try {
      await mkdir(gatePath, { mode: 0o700 })
      return
    } catch (error) {
      if (!(error instanceof Error && errnoIs(error, 'EEXIST'))) throw error
    }
    if (attempt === GATE_ATTEMPTS) break
    await (ports.wait ?? ((ms) => setTimeout(ms)))(GATE_WAIT_MS)
  }
  let info
  try {
    info = await lstat(gatePath)
  } catch (error) {
    if (error instanceof Error && errnoIs(error, 'ENOENT')) throw lock.refuse({ kind: 'contended' })
    throw error
  }
  if ((ports.now ?? Date.now)() - info.mtimeMs > GATE_STUCK_MS)
    throw lock.refuse({ kind: 'gate-stuck' })
  throw lock.refuse({ kind: 'contended' })
}

/** The lock at its path, or null when none exists. An unreadable or invalid lock has `lock: null`. */
export async function snapshotLinkLock<T extends LinkLockHolder>(
  lock: LinkLock<T>,
): Promise<LinkLockSnapshot<T> | null> {
  try {
    let info = await (lock.ports.lstat ?? lstat)(lock.path)
    if (info.isDirectory()) throw lock.refuse({ kind: 'directory' })
    let holder: T | null = null
    try {
      const read = await lock.read()
      holder = lock.parse(read.text)
      if (holder) info = read.info
    } catch {
      /* Invalid locks are recoverable. */
    }
    return { info, lock: holder }
  } catch (error) {
    if (error instanceof Error && errnoIs(error, 'ENOENT')) return null
    throw error
  }
}

/** Remove `stale` under the gate only if it is still the same file and its holder is not live. */
export async function reclaimLinkLock<T extends LinkLockHolder>(
  lock: LinkLock<T>,
  stale: LinkLockSnapshot<T> | null,
): Promise<void> {
  await acquireRecoveryGate(lock)
  try {
    const current = await snapshotLinkLock(lock)
    // The inode also identifies unreadable or invalid locks. A replacement is never reclaimed.
    if (
      current &&
      stale &&
      current.info.dev === stale.info.dev &&
      current.info.ino === stale.info.ino &&
      current.lock?.token === stale.lock?.token &&
      (!current.lock || !(await lock.isLive(current.lock)))
    )
      await unlink(lock.path)
  } finally {
    await rmdir(lock.gatePath)
  }
}

/** Remove the lock under the gate if it still carries this acquirer's token. */
export async function releaseLinkLock<T extends LinkLockHolder>(lock: LinkLock<T>): Promise<void> {
  await acquireRecoveryGate(lock)
  try {
    const current = await snapshotLinkLock(lock)
    if (current?.lock?.token !== lock.token) return
    await unlink(lock.path)
  } finally {
    await rmdir(lock.gatePath)
  }
}

/** Publish one prepared lock under the recovery gate, without reclaiming any holder. */
export async function linkUnderRecoveryGate<T extends LinkLockHolder>(
  lock: LinkLock<T>,
  temp: string,
): Promise<void> {
  await acquireRecoveryGate(lock)
  try {
    await (lock.ports.link ?? link)(temp, lock.path)
  } finally {
    await rmdir(lock.gatePath)
  }
}

/**
 * Publish `body` at the lock path through the private file `temp`. A live
 * holder refuses; a stale or invalid lock is reclaimed once, then a second
 * loss refuses as contended. The temporary file is always removed.
 */
export async function publishLinkLock<T extends LinkLockHolder>(
  lock: LinkLock<T>,
  temp: string,
  body: string,
  guardPublication = false,
): Promise<void> {
  const existing = await snapshotLinkLock(lock)
  if (existing?.lock && (await lock.isLive(existing.lock)))
    throw lock.refuse({ kind: 'held', holder: existing.lock })
  const file = await open(temp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(body)
      await file.sync()
    } finally {
      await file.close()
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (guardPublication) await linkUnderRecoveryGate(lock, temp)
        else await (lock.ports.link ?? link)(temp, lock.path)
        return
      } catch (error) {
        if (!(error instanceof Error && errnoIs(error, 'EEXIST'))) throw error
        const stale = await snapshotLinkLock(lock)
        if (stale?.lock && (await lock.isLive(stale.lock)))
          throw lock.refuse({ kind: 'held', holder: stale.lock })
        if (attempt === 1) throw lock.refuse({ kind: 'contended' })
        await reclaimLinkLock(lock, stale)
      }
    }
  } finally {
    await unlink(temp)
  }
}
