import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { DirEntry, FileContent } from '@shared/models'

const ALWAYS_HIDDEN = new Set(['.git'])
const MAX_FILE_BYTES = 4 * 1024 * 1024

/**
 * List one directory level for the explorer tree (lazy loading).
 * Gitignore filtering uses `git check-ignore --stdin` when available.
 */
export async function listDir(
  workspacePath: string,
  dirPath: string,
  options: { showHidden?: boolean; respectGitignore?: boolean },
): Promise<DirEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  let visible = entries.filter((entry) => {
    if (ALWAYS_HIDDEN.has(entry.name)) return false
    if (!options.showHidden && entry.name.startsWith('.')) return false
    return entry.isDirectory() || entry.isFile()
  })

  if (options.respectGitignore !== false && visible.length > 0) {
    const ignored = await checkIgnored(
      workspacePath,
      visible.map((e) => join(dirPath, e.name)),
    )
    if (ignored) visible = visible.filter((e) => !ignored.has(join(dirPath, e.name)))
  }

  const result: DirEntry[] = visible.map((entry) => ({
    name: entry.name,
    path: join(dirPath, entry.name),
    relativePath: relative(workspacePath, join(dirPath, entry.name)).split(sep).join('/'),
    isDirectory: entry.isDirectory(),
  }))

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
      ['check-ignore', '--stdin'],
      { cwd: workspacePath, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve(new Set(stdout.split('\n').filter(Boolean)))
        if ((error as { code?: number }).code === 1) return resolve(new Set())
        resolve(null)
      },
    )
    child.stdin?.on('error', () => {
      // Pipe closed early (git already exited); the callback decides the result.
    })
    child.stdin?.end(paths.join('\n'))
  })
}

export async function readTextFile(path: string): Promise<FileContent> {
  const info = await stat(path)
  if (info.size > MAX_FILE_BYTES) {
    return { path, content: '', tooLarge: true, size: info.size, mtimeMs: info.mtimeMs }
  }
  const buffer = await readFile(path)
  // Cheap binary sniff: NUL byte in the first 8k.
  const probe = buffer.subarray(0, 8192)
  if (probe.includes(0)) {
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
