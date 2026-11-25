import type { ComposerDraftRecord, DraftAttachment } from '@shared/models'
import type { PendingAttachment } from '@/features/chat/attachments'
import type { Draft, DraftKey } from './drafts'

export async function saveDraft(key: DraftKey, draft: Draft, current: () => boolean) {
  const saved = await Promise.all(draft.attachments.map((a) => saveAttachment(a, current)))
  const images = new Map<PendingAttachment, PendingAttachment>()
  if (!current()) return images
  await window.phosphor.invoke('app:setDraft', {
    key,
    text: draft.text,
    attachments: saved.map((entry) => entry.record).filter((a): a is DraftAttachment => a !== null),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(draft.swarm !== undefined ? { swarm: draft.swarm } : {}),
    ...(draft.workspacePath ? { workspacePath: draft.workspacePath } : {}),
    ...(draft.preferWorktree !== undefined ? { preferWorktree: draft.preferWorktree } : {}),
    updatedAt: Date.now(),
  })
  for (const [i, entry] of saved.entries())
    if (entry.attachment) images.set(draft.attachments[i]!, entry.attachment)
  return images
}

/**
 * Write an image's bytes if they are not on disk yet.
 *
 * `attachment` comes back non-null when it gained a blobId and the caller
 * should keep the new object; `record` is what goes into prefs, and is null
 * when the write was refused for the size cap — the chip stays in memory, it
 * just will not survive a restart.
 */
async function saveAttachment(
  attachment: PendingAttachment,
  current: () => boolean,
): Promise<{ record: DraftAttachment | null; attachment: PendingAttachment | null }> {
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
  if (!blobId) {
    blobId = crypto.randomUUID()
    const ok = await window.phosphor.invoke('app:writeDraftBlob', blobId, attachment.data)
    if (!current() || !ok) return { record: null, attachment: null }
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
  }
}

export async function loadDraft(
  record: ComposerDraftRecord,
  current: () => boolean,
): Promise<Draft> {
  const attachments = await Promise.all(
    record.attachments.map(async (a): Promise<PendingAttachment | null> => {
      if (!current()) return null
      if (a.kind === 'file') {
        return a.path ? { kind: 'file', path: a.path, name: a.name, size: a.size } : null
      }
      if (!a.blobId) return null
      const data = await window.phosphor.invoke('app:readDraftBlob', a.blobId)
      // The file is gone: drop the chip rather than showing a broken image.
      if (!current() || data === null) return null
      // Carrying the blobId back means re-saving this draft reuses the file
      // already on disk instead of writing a second copy of the same bytes.
      return {
        kind: 'image',
        data,
        mimeType: a.mimeType ?? 'image/png',
        name: a.name,
        blobId: a.blobId,
      }
    }),
  )
  return {
    text: record.text,
    attachments: attachments.filter((a): a is PendingAttachment => a !== null),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    ...(record.swarm !== undefined ? { swarm: record.swarm } : {}),
    ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
    ...(record.preferWorktree !== undefined ? { preferWorktree: record.preferWorktree } : {}),
  }
}
