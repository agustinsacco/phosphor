import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
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

/** The writer lock as the shared link-lock core sees it, for this acquirer's `token`. */
export function writerLinkLock(
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

/** This process's writer record, as the lock file's text. */
export async function writerRecordText(ports: OwnerLockPorts, token: string): Promise<string> {
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
  return JSON.stringify(record) + '\n'
}

/** Takes the writer lock for this process, or throws `HostBrainWriterBusy`. */
export async function acquireHostBrainWriterLock(
  stateDirectory: string,
  options: HostBrainWriterLockOptions = {},
): Promise<HostBrainWriterLock> {
  const token = randomBytes(32).toString('hex')
  const { lock, ports } = writerLinkLock(stateDirectory, token, options)
  await publishLinkLock(
    lock,
    `${lock.path}.${token}.tmp`,
    await writerRecordText(ports, token),
    true,
  )
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

interface ProcessWriter {
  holds: number
  lock?: HostBrainWriterLock
  /** The last take or release on this entry: they run one after another. */
  settled: Promise<unknown>
}

/** This process's writer locks, by pid and state folder; tests inject other pids as processes. */
const processWriters = new Map<string, ProcessWriter>()

function processWriter(stateDirectory: string, options: HostBrainWriterLockOptions) {
  const key = `${(options.ports ?? ownerLockPorts).pid}\0${resolve(stateDirectory)}`
  let entry = processWriters.get(key)
  if (!entry) processWriters.set(key, (entry = { holds: 0, settled: Promise.resolve() }))
  return entry
}

function settle<T>(entry: ProcessWriter, step: () => Promise<T>): Promise<T> {
  const next = entry.settled.then(step)
  entry.settled = next.catch(() => undefined)
  return next
}

/**
 * A hold on this process's writer lock. The Brain's lifetime writer and the handover share one
 * lock per process: the first hold takes it across processes (or throws `HostBrainWriterBusy`),
 * further holds in this process never wait on it, and the last release gives it back. A release
 * that fails keeps the lock as this process's, so the next hold reuses it and retries.
 */
export async function leaseHostBrainWriter(
  stateDirectory: string,
  options: HostBrainWriterLockOptions = {},
): Promise<HostBrainWriterLock> {
  const entry = processWriter(stateDirectory, options)
  await settle(entry, async () => {
    entry.lock ??= await acquireHostBrainWriterLock(stateDirectory, options)
    entry.holds++
  })
  let released = false
  return {
    release() {
      if (released) return Promise.resolve()
      released = true
      return settle(entry, async () => {
        entry.holds--
        if (entry.holds > 0 || !entry.lock) return
        await entry.lock.release()
        entry.lock = undefined
      })
    },
  }
}

/** Whether this process holds the writer lock now. */
function heldByThisProcess(stateDirectory: string, options: HostBrainWriterLockOptions): boolean {
  return processWriter(stateDirectory, options).lock !== undefined
}

/**
 * One HostBrain's hold on the writer lock: taken before the store opens, released on dispose.
 * `busy()` stays true after a refusal until a background re-read finds no live holder in another
 * process, so a synchronous state can report the refusal and still recover once the holder exits
 * or dies.
 */
export function hostBrainWriter(stateDirectory: string, options: HostBrainWriterLockOptions = {}) {
  let lease: HostBrainWriterLock | undefined
  let taking: Promise<void> | undefined
  let busy = false
  let rereading = false
  return {
    held: () => lease !== undefined,
    busy(): boolean {
      if (busy && !rereading && !taking) {
        rereading = true
        hostBrainWriterHeld(stateDirectory, options)
          .then(
            (live) => (busy = live && !heldByThisProcess(stateDirectory, options)),
            () => undefined,
          )
          .finally(() => (rereading = false))
          .catch(() => undefined)
      }
      return busy
    },
    /** Takes the lock once; concurrent callers share one attempt. Throws `HostBrainWriterBusy`. */
    take(): Promise<void> {
      if (lease) return Promise.resolve()
      taking ??= leaseHostBrainWriter(stateDirectory, options).then(
        (taken) => {
          lease = taken
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
      const held = lease
      lease = undefined
      await held?.release()
    },
  }
}
