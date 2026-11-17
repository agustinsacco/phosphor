import { realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { statIfPresent } from '@phosphor/session-runtime/lane-archive/files'
import type { ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'

export const archiveAttachmentsPath = (directory: string, id: string) =>
  join(directory, 'attachments', `${id}.archived`)
export async function attachmentIdentity(directory: string, id: string) {
  const path = join(directory, 'attachments', id)
  const info = await statIfPresent(path)
  if (!info) return undefined
  if (
    !info.isDirectory() ||
    dirname(await realpath(path)) !== (await realpath(join(directory, 'attachments')))
  )
    throw new Error('Unsafe attachment directory')
  return { dev: info.dev, ino: info.ino }
}

/** Park beside the lane folder: the old Host's UUID-only sweep also leaves this name alone. */
export async function moveArchiveAttachments(
  directory: string,
  record: ArchiveRecord,
  restore = false,
) {
  const original = join(directory, 'attachments', record.id)
  const parked = archiveAttachmentsPath(directory, record.id)
  const [from, to] = restore ? [parked, original] : [original, parked]
  const source = await statIfPresent(from)
  const target = await statIfPresent(to)
  const identity = record.metadata?.attachments as { dev?: number; ino?: number } | undefined
  const owned = (info: typeof source) =>
    info?.isDirectory() && info.dev === identity?.dev && info.ino === identity?.ino
  if (!source && !target) return
  if (!source && owned(target)) return
  if (!owned(source) || target)
    throw new Error('Attachment directory changed. Nothing was overwritten.')
  await rename(from, to)
}

export async function purgeArchiveAttachments(directory: string, record: ArchiveRecord) {
  const path = archiveAttachmentsPath(directory, record.id)
  const info = await statIfPresent(path)
  if (!info) return
  const identity = record.metadata?.attachments as { dev?: number; ino?: number } | undefined
  if (!info.isDirectory() || info.dev !== identity?.dev || info.ino !== identity?.ino)
    throw new Error('Attachment directory changed. Cleanup refused.')
  await rm(path, { recursive: true })
}
