/**
 * `<state>/brain-writer.lock` as `uninstall --purge` sees it. The purge deletes the Brain, so it
 * first holds the same writer lock every Host process takes before it writes there, and never
 * deletes whatever sits at the lock path:
 * - a folder, an unreadable or invalid record, or a live holder refuses, and stays;
 * - a valid record of a dead holder is reclaimed only under the recovery gate, and only while it
 *   is still the same file with the same token (`reclaimLinkLock`), so a replacement stays;
 * - the purge's own record is then linked into place only where nothing is, never over a lock;
 * - a recovery gate left by an interrupted reclamation is never removed: the refusal says how.
 * Refusals name only the lock's file names, never a path or a holder.
 */
import { randomBytes } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import {
  linkUnderRecoveryGate,
  reclaimLinkLock,
  releaseLinkLock,
  snapshotLinkLock,
} from '@phosphor/session-runtime/owner-lock/link-lock'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import {
  HOST_BRAIN_WRITER_LOCK,
  HostBrainWriterBusy,
  writerLinkLock,
  writerRecordText,
} from '../brain/writer-lock'

export const HOST_BRAIN_WRITER_GATE = `${HOST_BRAIN_WRITER_LOCK}-recovery`

const KEPT = 'Nothing in the state folder was purged.'
const IF_STOPPED = 'If no Phosphor Host is running,'
export const WRITER_REPAIR = `Brain writer lock recovery was interrupted. ${IF_STOPPED} remove ${HOST_BRAIN_WRITER_GATE} from the Host state folder, then retry. ${KEPT}`
const WRITER_FOLDER = `Brain writer lock is a folder. ${IF_STOPPED} move ${HOST_BRAIN_WRITER_LOCK} out of the Host state folder, then retry. ${KEPT}`
const WRITER_INVALID = `Brain writer lock is unreadable. ${IF_STOPPED} remove ${HOST_BRAIN_WRITER_LOCK} from the Host state folder, then retry. ${KEPT}`
const WRITER_LIVE = `Brain writer lock is held by a running Phosphor Host. Stop it, then retry. ${KEPT}`
const WRITER_CHANGED = `Brain writer lock changed during uninstall; retry. ${KEPT}`

function purgeRefusal(error: unknown): unknown {
  if (!(error instanceof HostBrainWriterBusy)) return error
  if (error.refusal === 'gate-stuck') return new Error(WRITER_REPAIR)
  if (error.refusal === 'directory') return new Error(WRITER_FOLDER)
  if (error.refusal === 'held') return new Error(WRITER_LIVE)
  return new Error(WRITER_CHANGED)
}

/** The lock now: absent, or a valid record whose holder is not live. Refuses anything else. */
async function staleOrAbsent(state: string, uid: number | undefined) {
  const { lock } = writerLinkLock(state, '', { uid })
  const current = await snapshotLinkLock(lock).catch((error: unknown) => {
    throw purgeRefusal(error)
  })
  if (!current) return null
  if (!current.lock) throw new Error(WRITER_INVALID)
  if (await lock.isLive(current.lock)) throw new Error(WRITER_LIVE)
  return current
}

/** Read-only: refuses before anything is changed when the purge could not take the lock. */
export async function checkPurgeWriterLock(state: string, uid: number | undefined): Promise<void> {
  await staleOrAbsent(state, uid)
}

/** Holds the writer lock for the purge; release removes only the purge's own record. */
export async function holdPurgeWriterLock(
  state: string,
  uid: number | undefined,
): Promise<{ release(): Promise<void> }> {
  const stale = await staleOrAbsent(state, uid)
  const token = randomBytes(32).toString('hex')
  const { lock, ports } = writerLinkLock(state, token, { uid })
  if (stale)
    await reclaimLinkLock(lock, stale).catch((error: unknown) => {
      throw purgeRefusal(error)
    })
  const temp = `${lock.path}.${token}.tmp`
  const file = await open(temp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(await writerRecordText(ports, token))
      await file.sync()
    } finally {
      await file.close()
    }
    await linkUnderRecoveryGate(lock, temp).catch((error: unknown) => {
      // Something is at the lock path again: never replace or remove it.
      throw errnoIs(error, 'EEXIST') ? new Error(WRITER_CHANGED) : purgeRefusal(error)
    })
  } finally {
    await unlink(temp)
  }
  return { release: () => releaseLinkLock(lock) }
}
