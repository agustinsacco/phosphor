import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'

/** A refusal with a fixed sentence the user may read. */
export class TransferRefusal extends Error {}

export function refuse(message: string): never {
  throw new TransferRefusal(message)
}

/** Size of a regular, non-symlinked file, or null for anything else (including absence). */
export async function regularSize(path: string): Promise<number | null> {
  try {
    const stat = await lstat(path)
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null
  } catch {
    return null
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Every regular file under `root`, as relative POSIX paths, sorted. Symlinks
 * and special files are skipped, never followed. Past `cap` entries it throws:
 * a partial walk must not pass for a whole one.
 */
export async function walkFiles(root: string, cap: number): Promise<string[]> {
  const found: string[] = []
  async function visit(relative: string): Promise<void> {
    const dir = await opendir(relative ? join(root, relative) : root)
    for await (const entry of dir) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        found.push(path)
        if (found.length > cap) refuse('This lane has too many files to move.')
      }
    }
  }
  if (await isDirectory(root)) await visit('')
  return found.sort()
}
