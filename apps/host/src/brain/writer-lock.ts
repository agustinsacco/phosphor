import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isIsoTime } from '@phosphor/shared/control-api'
import {
  publishLinkLock,
  releaseLinkLock,
  snapshotLinkLock,
  type LinkLock,
  type LinkLockPorts,
  type LinkLockRefusal,
} from '@phosphor/session-runtime/owner-lock/link-lock'
import {
  isOwnerLockHolderLive,
  ownerLockPorts,
  readPrivateLockFile,
} from '@phosphor/session-runtime/owner-lock/owner-lock'
import type { OwnerLockPorts } from '@phosphor/session-runtime/owner-lock/types'

/**
 * `<state>/brain-writer.lock`: the one process that may open `<state>/brain`. Host processes with
 * different configs (so different identity run locks) can share a state folder, so the Brain's
 * writer is fenced here, across processes, not by the run lock. It sits beside `<state>/brain`,
 * never inside it, so a handover still finds its target empty. A killed holder's lock is
 * reclaimed by the next writer (dead pid, or a reused pid with another start time); a live
 * holder's never is.
 */
export const HOST_BRAIN_WRITER_LOCK = 'brain-writer.lock'

interface HostBrainWriterRecord {
  readonly version: 1
  readonly pid: number
  readonly processStart: string | null
  readonly token: string
  readonly startedAt: string
}

/** Another live process holds the writer lock, or is taking or recovering it. */
export class HostBrainWriterBusy extends Error {
  constructor(readonly refusal: LinkLockRefusal<HostBrainWriterRecord>['kind']) {
    super(
      refusal === 'gate-stuck' || refusal === 'directory'
        ? `Brain's writer lock needs repair: remove ${HOST_BRAIN_WRITER_LOCK}-recovery or a folder named ${HOST_BRAIN_WRITER_LOCK} in the Host state folder if no Host is running.`
        : 'Brain is open elsewhere on this Host.',
    )
    this.name = 'HostBrainWriterBusy'
  }
}

export interface HostBrainWriterLock {
  release(): Promise<void>
}

export interface HostBrainWriterLockOptions extends LinkLockPorts {
  readonly ports?: OwnerLockPorts
  readonly uid?: number
}

const MAX_START_LENGTH = 256

export function parseHostBrainWriterRecord(text: string): HostBrainWriterRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (
    v.version !== 1 ||
    typeof v.pid !== 'number' ||
    !Number.isSafeInteger(v.pid) ||
    v.pid <= 0 ||
    v.pid > 2147483647 ||
    (v.processStart !== null &&
      (typeof v.processStart !== 'string' ||
        !v.processStart ||
        v.processStart.length > MAX_START_LENGTH)) ||
    typeof v.token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(v.token) ||
    !isIsoTime(v.startedAt)
  )
    return null
  return {
    version: 1,
    pid: v.pid,
    processStart: v.processStart,
    token: v.token,
    startedAt: v.startedAt,
  }
}

function writerLinkLock(
  stateDirectory: string,
  token: string,
  options: HostBrainWriterLockOptions,
): { lock: LinkLock<HostBrainWriterRecord>; ports: OwnerLockPorts } {
  const { ports = ownerLockPorts, uid = process.getuid?.(), ...linkPorts } = options
  const path = join(stateDirectory, HOST_BRAIN_WRITER_LOCK)
  const lock: LinkLock<HostBrainWriterRecord> = {
    path,
    gatePath: `${path}-recovery`,
    token,
    ports: linkPorts,
    read: () => readPrivateLockFile(path, uid),
    parse: parseHostBrainWriterRecord,
    isLive: (holder) => isOwnerLockHolderLive(holder, ports),
    refuse: (refusal) => new HostBrainWriterBusy(refusal.kind),
  }
  return { lock, ports }
}

/** Takes the writer lock for this process, or throws `HostBrainWriterBusy`. */
export async function acquireHostBrainWriterLock(
  stateDirectory: string,
  options: HostBrainWriterLockOptions = {},
): Promise<HostBrainWriterLock> {
  const token = randomBytes(32).toString('hex')
  const { lock, ports } = writerLinkLock(stateDirectory, token, options)
  const processStart = await ports.processStart(ports.pid)
  const record: HostBrainWriterRecord = {
    version: 1,
    pid: ports.pid,
    // A start time the parser would refuse is recorded as unknown, never as an invalid lock
    // that another process could reclaim from this live one.
    processStart: processStart && processStart.length <= MAX_START_LENGTH ? processStart : null,
    token,
    startedAt: new Date().toISOString(),
  }
  await publishLinkLock(lock, `${lock.path}.${token}.tmp`, JSON.stringify(record) + '\n')
  return { release: () => releaseLinkLock(lock) }
}

/** Whether a live process holds the writer lock now. Reads only; takes and removes nothing. */
export async function hostBrainWriterHeld(
  stateDirectory: string,
  options: HostBrainWriterLockOptions = {},
): Promise<boolean> {
  const { lock } = writerLinkLock(stateDirectory, '', options)
  const current = await snapshotLinkLock(lock)
  return current?.lock ? await lock.isLive(current.lock) : false
}

/**
 * One HostBrain's hold on the writer lock: taken before the store opens, released on dispose.
 * `busy()` stays true after a refusal until a background re-read finds no live holder, so a
 * synchronous state can report the refusal and still recover once the holder exits or dies.
 */
export function hostBrainWriter(stateDirectory: string, options: HostBrainWriterLockOptions = {}) {
  let lock: HostBrainWriterLock | undefined
  let taking: Promise<void> | undefined
  let busy = false
  let rereading = false
  return {
    held: () => lock !== undefined,
    busy(): boolean {
      if (busy && !rereading && !taking) {
        rereading = true
        hostBrainWriterHeld(stateDirectory, options)
          .then(
            (live) => (busy = live),
            () => undefined,
          )
          .finally(() => (rereading = false))
          .catch(() => undefined)
      }
      return busy
    },
    /** Takes the lock once; concurrent callers share one attempt. Throws `HostBrainWriterBusy`. */
    take(): Promise<void> {
      if (lock) return Promise.resolve()
      taking ??= acquireHostBrainWriterLock(stateDirectory, options).then(
        (taken) => {
          lock = taken
          busy = false
          taking = undefined
        },
        (error: unknown) => {
          busy = error instanceof HostBrainWriterBusy
          taking = undefined
          throw error
        },
      )
      return taking
    },
    async release(): Promise<void> {
      await taking?.catch(() => undefined)
      const held = lock
      lock = undefined
      await held?.release()
    },
  }
}
