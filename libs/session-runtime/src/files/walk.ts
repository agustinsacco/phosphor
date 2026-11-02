import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Dependency, build and cache names no file list includes or descends into, at any depth. */
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
  /** The walk stopped at `limit` files or at its entry budget with more left. */
  truncated: boolean
}

export interface WalkOptions {
  /** Stops the walk part-way; it rejects with the signal's reason. */
  signal?: AbortSignal
  /** Directory entries to read in all, skipped and ignored ones included. */
  entries?: number
}

/**
 * The files below `root` for a folder git does not list: Desktop's fallback and
 * the Host's. Skips `WALK_IGNORES` and hidden folders at any depth (hidden files
 * stay), leaves out symlinks and anything else that is not a regular file, skips
 * a folder it cannot read, and stops at `limit` files or after reading
 * `entries` directory entries, so a tree of many folders and few files ends too.
 */
export async function walkFiles(
  root: string,
  limit: number,
  { signal, entries = Infinity }: WalkOptions = {},
): Promise<WalkedFiles> {
  const files: string[] = []
  const truncated = await walk({ root, files, limit, signal, left: entries }, '')
  return { files, truncated }
}

interface Walk {
  root: string
  files: string[]
  limit: number
  signal: AbortSignal | undefined
  /** Entries the walk may still read. */
  left: number
}

/** Collect files below `dir`; true when it stopped at a bound with more left. */
async function walk(state: Walk, dir: string): Promise<boolean> {
  const { root, files, limit, signal } = state
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (--state.left < 0) return true
    // `.GIT` names the same folder on a case-insensitive disk; a worktree's `.git` is a file.
    if (WALK_IGNORES.has(entry.name) || entry.name.toLowerCase() === '.git') continue
    if (entry.name.startsWith('.') && entry.isDirectory()) continue
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (await walk(state, path)) return true
    } else if (entry.isFile()) {
      if (files.length >= limit) return true
      files.push(path)
    }
  }
  return false
}
