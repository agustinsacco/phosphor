import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import {
  lstat,
  mkdir,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { mapLimit } from '@phosphor/session-runtime/map-limit'
import {
  isTextPreview,
  looksBinary,
  MAX_TEXT_FILE_BYTES,
  previewKindForPath,
} from '@shared/file-kinds'
import type { DirEntry, FileContent } from '@shared/models'

const ALWAYS_HIDDEN = new Set(['.git'])
export const MAX_LINK_DIR_ENTRIES = 2_000

/** Git doesn't traverse symlinks. Record the first link for ignore checks,
 * and canonical ancestors to disallow walking back into the same directory. */
async function directoryContext(workspacePath: string, dirPath: string) {
  const rel = relative(workspacePath, dirPath)
  const parts = rel ? rel.split(sep) : []
  const ancestors = new Set<string>()
  let canonical = await realpath(workspacePath)
  ancestors.add(canonical)
  let firstLink: string | undefined
  let path = workspacePath
  if (isAbsolute(rel) || parts[0] === '..') throw new Error('Folder is outside the workspace.')
  for (const part of parts) {
    path = join(path, part)
    const target = await realpath(path)
    if (ancestors.has(target)) throw new Error('Cannot expand a symlink loop.')
    if (target !== join(canonical, part)) firstLink ??= path
    ancestors.add(target)
    canonical = target
  }
  return { ancestors, firstLink }
}

async function readLinkDirectory(path: string): Promise<Dirent[]> {
  const entries: Dirent[] = []
  for await (const entry of await opendir(path)) {
    if (entries.length === MAX_LINK_DIR_ENTRIES) {
      throw new Error('Linked folder is too large to list (more than 2,000 entries).')
    }
    entries.push(entry)
  }
  return entries
}

async function linkTarget(
  path: string,
  ancestors: Set<string>,
): Promise<Pick<DirEntry, 'isDirectory' | 'symlink'>> {
  try {
    const target = await realpath(path)
    if (ancestors.has(target)) return { isDirectory: false, symlink: 'loop' }
    const info = await stat(target)
    if (info.isDirectory() || info.isFile()) {
      return { isDirectory: info.isDirectory(), symlink: 'resolved' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      return { isDirectory: false, symlink: 'loop' }
    }
  }
  return { isDirectory: false, symlink: 'unavailable' }
}

/** Read directory mtimes for the explorer's polling fallback. */
export async function statDirectories(
  paths: string[],
): Promise<Array<{ path: string; mtimeMs: number | null }>> {
  return Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path)
        return { path, mtimeMs: info.isDirectory() ? info.mtimeMs : null }
      } catch {
        return { path, mtimeMs: null }
      }
    }),
  )
}

/**
 * List one directory level for the explorer tree (lazy loading).
 * Annotate Git-ignored entries even when the explorer is showing them.
 */
export async function listDir(
  workspacePath: string,
  dirPath: string,
  options: { showHidden?: boolean; respectGitignore?: boolean },
): Promise<DirEntry[]> {
  const { ancestors, firstLink } = await directoryContext(workspacePath, dirPath)
  const entries = firstLink
    ? await readLinkDirectory(dirPath)
    : await readdir(dirPath, { withFileTypes: true })
  const candidates = entries.flatMap((entry) => {
    if (ALWAYS_HIDDEN.has(entry.name) || (!options.showHidden && entry.name.startsWith('.'))) {
      return []
    }
    if (!(entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())) return []
    const path = join(dirPath, entry.name)
    // A directory-only pattern must not match a symlink to a directory.
    const checkPath = firstLink ?? (entry.isDirectory() ? path + sep : path)
    return [{ entry, path, checkPath }]
  })
  const toCheck = [...new Set(candidates.map(({ checkPath }) => checkPath))]
  const ignored = toCheck.length ? await checkIgnored(workspacePath, toCheck) : null
  const result = await mapLimit(
    candidates.filter(({ checkPath }) => !options.respectGitignore || !ignored?.has(checkPath)),
    16,
    async ({ entry, path, checkPath }): Promise<DirEntry> => ({
      name: entry.name,
      path,
      relativePath: relative(workspacePath, path).split(sep).join('/'),
      ...(ignored?.has(checkPath) && { isIgnored: true }),
      ...(entry.isSymbolicLink()
        ? await linkTarget(path, ancestors)
        : { isDirectory: entry.isDirectory() }),
    }),
  )

  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return result
}

/**
 * Returns the subset of paths that are gitignored, or null when not a repo.
 *
 * Three things here are load-bearing:
 *
 * 1. `stdin.on('error')`. Without it this function could CRASH the main
 *    process: outside a git repo `check-ignore` exits immediately, so a large
 *    stdin write hits a closed pipe and the unhandled EPIPE became an uncaught
 *    exception (reproduced with a non-repo dir and 200k paths).
 * 2. `timeout` + `maxBuffer`, matching every other subprocess in the codebase.
 *    This runs per explorer directory read, which the workspace watcher can
 *    drive repeatedly while an agent writes files.
 * 3. Exit code 1 means "nothing is ignored" — a normal answer, NOT a failure.
 *    Only a different code means "cannot tell", which disables filtering.
 *
 * Note: `execFile`'s `input` option does not exist (that is `execFileSync`);
 * stdin must be written on the returned child handle or git waits forever and
 * every call dies on the timeout with filtering silently disabled.
 */
function checkIgnored(workspacePath: string, paths: string[]): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['check-ignore', '-z', '--stdin'],
      { cwd: workspacePath, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve(new Set(stdout.split('\0').filter(Boolean)))
        if ((error as { code?: number }).code === 1) return resolve(new Set())
        resolve(null)
      },
    )
    child.stdin?.on('error', () => {
      // Pipe closed early (git already exited); the callback decides the result.
    })
    child.stdin?.end(paths.join('\0') + '\0')
  })
}

export async function readTextFile(path: string): Promise<FileContent> {
  const info = await stat(path)
  // Media and PDFs are streamed to their viewer over phosphor-file://, so
  // reading up to 4 MB of one here just to sniff a NUL byte is pure waste —
  // and this runs again on every on-disk change to an open file.
  if (previewKindForPath(path) && !isTextPreview(path)) {
    return { path, content: '', binary: true, size: info.size, mtimeMs: info.mtimeMs }
  }
  if (info.size > MAX_TEXT_FILE_BYTES) {
    return { path, content: '', tooLarge: true, size: info.size, mtimeMs: info.mtimeMs }
  }
  const buffer = await readFile(path)
  if (looksBinary(buffer)) {
    return { path, content: '', binary: true, size: info.size, mtimeMs: info.mtimeMs }
  }
  return { path, content: buffer.toString('utf8'), size: info.size, mtimeMs: info.mtimeMs }
}

export async function writeTextFile(path: string, content: string): Promise<{ mtimeMs: number }> {
  await writeFile(path, content, 'utf8')
  const info = await stat(path)
  return { mtimeMs: info.mtimeMs }
}

export async function createFile(path: string): Promise<void> {
  await writeFile(path, '', { flag: 'wx' })
}

export async function createDir(path: string): Promise<void> {
  await mkdir(path)
}

/** lstat also detects dangling symlinks: they must not be overwritten. */
export async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`Already exists: ${path}`)
}

export async function renamePath(from: string, to: string): Promise<void> {
  await requireMissing(to)
  await rename(from, to)
}
