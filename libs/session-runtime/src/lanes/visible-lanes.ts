import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { sessionDirNameForCwd } from '../pi/pi-paths'
export async function sessionCwd(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) return null
    const buffer = Buffer.alloc(16_384)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const header = JSON.parse(buffer.toString('utf8', 0, bytesRead).split('\n')[0]!) as {
      type?: string
      cwd?: string
    }
    return header.type === 'session' && header.cwd && isAbsolute(header.cwd) ? header.cwd : null
  } finally {
    await handle.close()
  }
}

/** Header-based discovery survives checkout deletion, including pre-upgrade losses. */
export async function discoverRetainedWorkspaces(
  repoPath: string,
  root: string,
  removals: readonly string[] = [],
  signal?: AbortSignal,
): Promise<string[]> {
  const found = new Set(removals)
  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return [...found]
  }
  const prefix = sessionDirNameForCwd(repoPath).slice(0, -2)
  for (const dir of dirs.filter((name) => name.startsWith(prefix))) {
    signal?.throwIfAborted()
    let files: string[]
    try {
      files = (await readdir(join(root, dir), { withFileTypes: true }))
        .filter((f) => f.isFile())
        .map((f) => f.name)
    } catch {
      continue
    }
    for (const file of files.filter((name) => name.endsWith('.jsonl'))) {
      signal?.throwIfAborted()
      try {
        const cwd = await sessionCwd(join(root, dir, file))
        if (!cwd) continue
        const rel = relative(join(repoPath, '.phosphor', 'worktrees'), cwd)
        if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) found.add(cwd)
      } catch {
        /* A malformed or concurrently deleted transcript does not hide other histories. */
      }
    }
  }
  return [...found].filter((path) => path !== repoPath)
}
