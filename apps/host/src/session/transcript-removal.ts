import { lstat, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { errnoIs } from '../fs-safety'

/**
 * Unlink a transcript only when it is one of pi's: a regular `.jsonl`, not a
 * link, directly in a folder of pi's session root. The parser confined the
 * file a request names; this also holds for a file pi reported for a
 * session. A file whose folder is gone is gone too. Without a session root,
 * nothing is one of pi's files.
 */
export async function unlinkTranscript(
  path: string,
  remove: (path: string) => Promise<void> = unlink,
): Promise<void> {
  let folder: string
  try {
    folder = await realpath(dirname(path))
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return
    throw error
  }
  const root = await realpath(piSessionsRoot()).catch(() => null)
  if (root === null || dirname(folder) !== root) {
    throw new Error(`refusing to delete ${path}: not a pi session`)
  }
  const file = join(folder, basename(path))
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return
    throw error
  }
  // lstat describes a link itself, and a link is not a regular file.
  if (!/.\.jsonl$/.test(basename(file)) || !info.isFile()) {
    throw new Error(`refusing to delete ${path}: not a pi session file`)
  }
  await remove(file).catch((error: unknown) => {
    if (!errnoIs(error, 'ENOENT')) throw error
  })
}
