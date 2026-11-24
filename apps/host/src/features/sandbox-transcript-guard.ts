import { lstat } from 'node:fs/promises'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'

async function plainFolder(path: string) {
  try {
    const info = await lstat(path)
    if (!info.isDirectory()) throw new Error('Unsafe sandbox transcript folder.')
    return info
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null
    throw error
  }
}

/** Never repoint a database row onto another sandbox's old history or follow a transcript-directory link. */
export async function guardSandboxTranscripts(
  sources: readonly string[],
  targets?: readonly string[],
) {
  for (const [i, from] of sources.entries()) {
    const before = await plainFolder(from)
    const to = targets?.[i]
    if (!to) continue
    const after = await plainFolder(to)
    if (after && (after.dev !== before?.dev || after.ino !== before.ino))
      throw new Error('The new sandbox name already has transcript history.')
  }
}
