import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Dependency, build and cache folders no file list descends into, at any depth. */
export const WALK_IGNORES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
])

export interface WalkedFiles {
  /** Root-relative, `/`-separated, in walk order. */
  files: string[]
  /** The folder holds more than `limit` files; `files` is the first of them. */
  truncated: boolean
}

/**
 * The files below `root` for a folder git does not list: Desktop's fallback and
 * the Host's. Skips `WALK_IGNORES` and hidden folders at any depth (hidden files
 * stay), leaves out symlinks and anything else that is not a regular file, skips
 * a folder it cannot read, and stops at `limit` files.
 *
 * `signal` stops the walk part-way and rejects with its reason.
 */
export async function walkFiles(
  root: string,
  limit: number,
  signal?: AbortSignal,
): Promise<WalkedFiles> {
  const files: string[] = []
  const truncated = await walk(root, '', files, limit, signal)
  return { files, truncated }
}

/** Collect files below `dir`; true when it stopped at `limit` with more left. */
async function walk(
  root: string,
  dir: string,
  files: string[],
  limit: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    // `.GIT` names the same folder on a case-insensitive disk; a worktree's `.git` is a file.
    if (WALK_IGNORES.has(entry.name) || entry.name.toLowerCase() === '.git') continue
    if (entry.name.startsWith('.') && entry.isDirectory()) continue
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (await walk(root, path, files, limit, signal)) return true
    } else if (entry.isFile()) {
      if (files.length >= limit) return true
      files.push(path)
    }
  }
  return false
}
