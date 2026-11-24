/**
 * The owner lock: one per pi agent dir (`<agentDir>/.phosphor-owner.lock`),
 * held by whichever process runs this machine's lanes, Desktop in-app or the
 * daemon. Types only; the lock itself lands beside this file.
 */

export type OwnerLockHolder = 'desktop' | 'daemon'

export interface OwnerLockRecord {
  readonly version: 1
  readonly owner: OwnerLockHolder
  readonly pid: number
  /** The holder's process start time, so a reused pid reads as stale. Null when unreadable. */
  readonly processStart: string | null
  readonly token: string
  readonly startedAt: string
  readonly program: string
}

export interface OwnerLockPorts {
  readonly pid: number
  isAlive(pid: number): boolean
  /** `ps -o lstart=` on macOS, `/proc/<pid>/stat` on Linux; null when it cannot be read. */
  processStart(pid: number): Promise<string | null>
}

/** Another live process holds the lock. */
export class OwnerLockBusy extends Error {
  readonly holder: OwnerLockRecord

  constructor(holder: OwnerLockRecord) {
    super(`The ${holder.owner} (pid ${holder.pid}) runs this machine's lanes.`)
    this.name = 'OwnerLockBusy'
    this.holder = holder
  }
}
