import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { isInsideRoot } from '../machine/repositories'
import { LaneCapacityReached, type HostStore } from './store'

export const RECONCILE_LIMITS = {
  worktreesPerRepository: 256,
} as const
const HEADER_BYTES = 8192
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

async function hasHeader(file: string, cwd: string): Promise<boolean> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) return false
    const bytes = Buffer.alloc(HEADER_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const end = bytes.subarray(0, bytesRead).indexOf(10)
    if (end < 0 || end > HEADER_BYTES) return false
    const value: unknown = JSON.parse(bytes.subarray(0, end).toString('utf8'))
    return (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'session' &&
      'id' in value &&
      isUuid(value.id) &&
      'cwd' in value &&
      value.cwd === cwd
    )
  } finally {
    await handle.close()
  }
}

/** Scan only names and the bounded first line. No transcript messages are loaded. */
export async function reconcile(
  store: HostStore,
  sessionsRoot: string,
  log: (skipped: number) => void = () => {},
  signal?: AbortSignal,
): Promise<{ repositories: number; lanes: number; added: number; removed: number }> {
  signal?.throwIfAborted()
  const repositories = store.listRepositories()
  const known = store.listLanes()
  const folders = new Map<string, string>()
  let added = 0
  let removed = 0
  let skipped = 0
  for (const repository of repositories) {
    signal?.throwIfAborted()
    folders.set(repository.path, repository.id)
    const directory = join(repository.path, '.phosphor', 'worktrees')
    try {
      const info = await lstat(directory)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !isInsideRoot(await realpath(directory), repository.path)
      ) {
        skipped++
        continue
      }
      let entries = 0
      for await (const entry of await opendir(directory)) {
        signal?.throwIfAborted()
        if (++entries > RECONCILE_LIMITS.worktreesPerRepository) {
          skipped++
          break
        }
        const path = join(directory, entry.name)
        try {
          const info = await lstat(path)
          const real = await realpath(path)
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            !isInsideRoot(real, repository.path)
          ) {
            skipped++
            continue
          }
          folders.set(real, repository.id)
        } catch {
          skipped++
        }
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (!missing(error)) skipped++
    }
  }
  for (const lane of known) {
    signal?.throwIfAborted()
    if (!repositories.some((repository) => repository.id === lane.repositoryId)) continue
    let cwd = lane.cwd
    try {
      cwd = await realpath(cwd)
    } catch {
      // A deleted worktree still needs its known files checked for ENOENT.
    }
    folders.set(cwd, lane.repositoryId)
  }
  // A scan failure is not proof of deletion. Only ENOENT on the exact file is.
  for (const lane of known) {
    if (!repositories.some((repository) => repository.id === lane.repositoryId)) continue
    signal?.throwIfAborted()
    if (lane.sessionFile === null) continue
    try {
      await lstat(lane.sessionFile)
    } catch (error) {
      if (missing(error)) {
        store.markRemoved(lane.laneId)
        removed++
      } else skipped++
    }
  }
  let liveLanes = store.listLanes().length
  let admissionsFull = false
  for (const [cwd, repositoryId] of folders) {
    if (admissionsFull) break
    signal?.throwIfAborted()
    const directory = sessionDirForCwd(cwd, sessionsRoot)
    let entries = 0
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        skipped++
        continue
      }
      const dir = await opendir(directory)
      for await (const entry of dir) {
        signal?.throwIfAborted()
        if (++entries > HOST_LIMITS.lanesPerHost * 2) {
          skipped++
          break
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = join(directory, entry.name)
        const existing = store.sessionLane(file)
        if (existing?.removedAt === null) continue
        if (liveLanes >= store.limits.lanesPerHost) {
          admissionsFull = true
          skipped++
          break
        }
        try {
          if (!(await hasHeader(file, cwd))) {
            skipped++
            continue
          }
          let storedCwd = cwd
          if (existing) {
            if (existing.repositoryId !== repositoryId || (await realpath(existing.cwd)) !== cwd) {
              skipped++
              continue
            }
            storedCwd = existing.cwd
          }
          // No await between this read and admission. A live row returned by
          // ensureLane is not an addition and must not consume the cached cap.
          const wasLive = store.sessionLane(file)?.removedAt === null
          store.ensureLane({
            repositoryId,
            cwd: storedCwd,
            sessionFile: file,
            worktree: !repositories.some((repository) => repository.path === cwd),
          })
          if (!wasLive) {
            liveLanes++
            added++
          }
        } catch (error) {
          skipped++
          if (error instanceof LaneCapacityReached) {
            admissionsFull = true
            break
          }
        }
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (!missing(error)) {
        skipped++
        continue
      }
    }
  }
  signal?.throwIfAborted()
  store.pruneRemovedLanes()
  if (skipped) log(skipped)
  return { repositories: repositories.length, lanes: store.listLanes().length, added, removed }
}
