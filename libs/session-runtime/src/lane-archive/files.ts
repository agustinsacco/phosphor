import { lstat, link, realpath, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ArchiveRecord } from './storage'

export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
export const parkedTranscript = (record: ArchiveRecord) => `${record.transcript}.archived`
export const statIfPresent = (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (missing(error)) return null
    throw error
  })

export async function assertArchiveDirectory(
  record: ArchiveRecord,
  sessionsRoot: string,
  allowMissing = false,
) {
  if (!record.transcript) return
  // The Desktop adapter removes empty session folders after trashing the transcript.
  // A dangling symlink is still present and must fail the normal realpath checks.
  if (allowMissing && !(await statIfPresent(dirname(record.transcript)))) return
  const directory = await realpath(dirname(record.transcript))
  if (
    directory !== record.identity?.directory ||
    dirname(directory) !== (await realpath(sessionsRoot))
  )
    throw new Error('The archived session directory changed. Nothing was removed.')
}

/** Same-filesystem move, no replacement, retryable after either syscall. */
export async function moveTranscript(
  source: string,
  target: string,
  identity: ArchiveRecord['identity'],
) {
  const from = await statIfPresent(source)
  const to = await statIfPresent(target)
  const owned = (info: typeof from) =>
    info?.isFile() && info.dev === identity?.dev && info.ino === identity?.ino
  if (!from && owned(to)) return
  if (!owned(from)) throw new Error('The saved conversation is missing or has been replaced.')
  if (to && !owned(to))
    throw new Error('A different conversation occupies the restore path. Nothing was overwritten.')
  if (!to) await link(source, target)
  await unlink(source)
}

export async function assertArchivedWorktree(record: ArchiveRecord) {
  const info = await statIfPresent(record.cwd)
  if (!info) return
  if (
    !record.checkout ||
    !info.isDirectory() ||
    info.dev !== record.checkout.dev ||
    info.ino !== record.checkout.ino ||
    (await realpath(record.cwd)) !== record.checkout.path
  )
    throw new Error('This checkout was replaced after archiving. Cleanup refused.')
}

export async function assertPurgeIdentity(record: ArchiveRecord) {
  if (!record.transcript) return
  const info = await statIfPresent(parkedTranscript(record))
  if (
    info &&
    (!info.isFile() || info.dev !== record.identity?.dev || info.ino !== record.identity?.ino)
  )
    throw new Error('The archived conversation has been replaced. Cleanup refused.')
}
