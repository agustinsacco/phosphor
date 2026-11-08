import { access, link, lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { extname, join } from 'node:path'

/**
 * Files Phosphor saves into the Downloads folder: one naming rule, and a
 * finished file that never replaces one already there.
 */

/** `name.ext`, then `name (2).ext`, `name (3).ext`… */
export function downloadName(fileName: string, n: number): string {
  if (n <= 1) return fileName
  const ext = extname(fileName)
  return `${fileName.slice(0, fileName.length - ext.length)} (${n})${ext}`
}

/** A name this file system takes, from one a remote machine chose. */
export function localFileName(name: string, fallback = 'download'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

const MAX_TRIES = 1000

/** The first free `downloadName` in `dir`, for a writer that creates the file at once. */
export async function uniqueDownloadPath(dir: string, fileName: string): Promise<string> {
  for (let n = 1; n < MAX_TRIES; n++) {
    const candidate = join(dir, downloadName(fileName, n))
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, downloadName(fileName, Date.now()))
}

const taken = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )
const code = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined

/** Create `<free name>.download` exclusively; nothing existing is ever opened. */
async function reservePart(dir: string, fileName: string) {
  for (let n = 1; n < MAX_TRIES; n++) {
    const part = `${join(dir, downloadName(fileName, n))}.download`
    if (await taken(part.slice(0, -'.download'.length))) continue
    try {
      // No execute bit, whatever the source had.
      return { part, handle: await open(part, 'wx', 0o644) }
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error
    }
  }
  throw new Error('No free download name.')
}

/** Give the finished part the first free name. A hard link cannot replace a file; rename can. */
async function publish(part: string, dir: string, fileName: string): Promise<string> {
  for (let n = 1; n < MAX_TRIES; n++) {
    const target = join(dir, downloadName(fileName, n))
    const linked = await link(part, target).then(
      () => true,
      (error: unknown) => code(error),
    )
    if (linked === true) {
      await unlink(part).catch(() => undefined)
      return target
    }
    if (linked === 'EEXIST' || (await taken(target))) continue
    // A file system without hard links: the name was free a moment ago.
    await rename(part, target)
    return target
  }
  throw new Error('No free download name.')
}

/**
 * Save a file into `dir` as `fileName` (numbered when taken). `fill` writes it
 * through a handle to a `.download` part; only a filled part gets the real name,
 * and a failed one is removed.
 */
export async function saveDownload(
  dir: string,
  fileName: string,
  fill: (handle: FileHandle) => Promise<void>,
): Promise<string> {
  const { part, handle } = await reservePart(dir, fileName)
  try {
    try {
      await fill(handle)
    } finally {
      await handle.close()
    }
    return await publish(part, dir, fileName)
  } catch (error) {
    await unlink(part).catch(() => undefined)
    throw error
  }
}
