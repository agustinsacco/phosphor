import type { DraftAttachment } from '@shared/models'
import type { PendingAttachment } from '@/features/chat/attachments'

/**
 * The newest save or clear of one draft wins. Every write starts at once, so newer
 * text never waits behind a slow image save and a send's clear reaches disk at once.
 * A write asks `latest()` just before its final prefs step and commits only if no
 * newer write of its key began: a stale image save that finishes late does nothing,
 * and cannot bring a sent draft back.
 */
const latestTicket = new Map<string, number>()
let writeTicket = 0

export function writeDraftInOrder(
  key: string,
  write: (latest: () => boolean) => Promise<void>,
): Promise<void> {
  const ticket = ++writeTicket
  latestTicket.set(key, ticket)
  const latest = () => latestTicket.get(key) === ticket
  const run = write(latest)
  // The caller's promise still reports a failed write; this only forgets the key.
  void run.then(
    () => latest() && latestTicket.delete(key),
    () => latest() && latestTicket.delete(key),
  )
  return run
}

/**
 * One image's blob write, shared by this draft's saves while any of them holds it, so
 * a newer save that keeps the image reuses it rather than writing the bytes again.
 * Keyed by draft too: the same image in two drafts gets two blobs, or clearing one
 * draft would unlink the other's bytes. Each save calls `release` once it is done;
 * `release` is true for the last save holding the upload.
 */
type BlobWrite = { run: Promise<string | null>; users: number }
const blobWrites = new Map<string, WeakMap<object, BlobWrite>>()

export function writeDraftBlobOnce(
  key: string,
  attachment: object,
  write: () => Promise<string | null>,
): { blobId: Promise<string | null>; release: () => boolean } {
  const writes = blobWrites.get(key) ?? new WeakMap<object, BlobWrite>()
  blobWrites.set(key, writes)
  let entry = writes.get(attachment)
  if (!entry) {
    // A failed write rejects every save sharing it, so none commits a partial draft
    // over the last good one; a refused write (null) still saves without the image.
    const created: BlobWrite = { run: write(), users: 0 }
    // Forget a failed write, so the next save of this image tries again.
    created.run.catch(() => {
      if (writes.get(attachment) === created) writes.delete(attachment)
    })
    entry = created
    writes.set(attachment, entry)
  }
  const held = entry
  held.users++
  let released = false
  const release = () => {
    if (released) return false
    released = true
    if (--held.users > 0) return false
    if (writes.get(attachment) === held) writes.delete(attachment)
    return true
  }
  return { blobId: held.run, release }
}

/** An image a save joined the upload of (`writeDraftBlobOnce`). */
export interface DraftUpload {
  blobId: string | null
  release: () => boolean
}

/**
 * A save that a newer write superseded records nothing, so its upload would be an
 * orphan until the next launch's sweep. The last save holding it deletes it, unless
 * a draft refers to it; main checks prefs again before unlinking. Fire and forget:
 * no draft text depends on it.
 */
export function reclaimDraftUploads(
  uploads: readonly (DraftUpload | undefined)[],
  referenced: (blobId: string) => boolean,
): void {
  for (const upload of uploads) {
    if (!upload?.release() || !upload.blobId || referenced(upload.blobId)) continue
    window.phosphor.invoke('app:deleteDraftBlob', upload.blobId).catch((error: unknown) => {
      console.warn('Could not delete an unused draft image', error)
    })
  }
}

/**
 * Write an image's bytes if they are not on disk yet.
 *
 * `attachment` comes back non-null when it gained a blobId and the caller
 * should keep the new object; `record` is what goes into prefs, and is null
 * when the write was refused for the size cap — the chip stays in memory, it
 * just will not survive a restart.
 */
export async function saveDraftAttachment(
  key: string,
  attachment: PendingAttachment,
  current: () => boolean,
): Promise<{
  record: DraftAttachment | null
  attachment: PendingAttachment | null
  upload?: DraftUpload
}> {
  if (!current()) return { record: null, attachment: null }
  if (attachment.kind === 'file') {
    if (attachment.data !== undefined) return { record: null, attachment: null }
    return {
      record: { kind: 'file', name: attachment.name, size: attachment.size, path: attachment.path },
      attachment: null,
    }
  }
  let blobId = attachment.blobId
  let updated: PendingAttachment | null = null
  let upload: DraftUpload | undefined
  if (!blobId) {
    const { data } = attachment
    const write = writeDraftBlobOnce(key, attachment, async () => {
      // crypto.randomUUID is available in the renderer under the strict CSP.
      const id = crypto.randomUUID()
      return (await window.phosphor.invoke('app:writeDraftBlob', id, data)) ? id : null
    })
    try {
      upload = { blobId: await write.blobId, release: write.release }
    } catch (error) {
      write.release()
      throw error
    }
    blobId = upload.blobId ?? undefined
    if (!current() || !blobId) return { record: null, attachment: null, upload }
    updated = { ...attachment, blobId }
  }
  return {
    record: {
      kind: 'image',
      name: attachment.name,
      size: attachment.data.length,
      blobId,
      mimeType: attachment.mimeType,
    },
    attachment: updated,
    ...(upload ? { upload } : {}),
  }
}
