import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { HostStore } from './store'

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
  log: (skipped: number) => void = () => {},
): Promise<{ repositories: number; lanes: number; added: number; removed: number }> {
  const repositories = store.listRepositories()
  const known = store.listLanes()
  const folders = new Map<string, string>()
  for (const repository of repositories) folders.set(repository.path, repository.id)
  for (const lane of known)
    if (repositories.some((repository) => repository.id === lane.repositoryId))
      folders.set(lane.cwd, lane.repositoryId)
  let added = 0
  let removed = 0
  let skipped = 0
  for (const [cwd, repositoryId] of folders) {
    const directory = sessionDirForCwd(cwd)
    let entries = 0
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        skipped++
        continue
      }
      const dir = await opendir(directory)
      for await (const entry of dir) {
        if (++entries > HOST_LIMITS.lanesPerHost * 2) {
          skipped++
          break
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = join(directory, entry.name)
        const existing = store.sessionLane(file)
        if (existing?.removedAt === null) continue
        if (store.listLanes().length >= HOST_LIMITS.lanesPerHost) {
          skipped++
          break
        }
        try {
          if (!(await hasHeader(file, cwd))) {
            skipped++
            continue
          }
          store.ensureLane({
            repositoryId,
            cwd,
            sessionFile: file,
            worktree: !repositories.some((repository) => repository.path === cwd),
          })
          added++
        } catch {
          skipped++
        }
      }
    } catch (error) {
      if (!missing(error)) {
        skipped++
        continue
      }
    }
    // A scan failure is not proof of deletion. Only ENOENT on the exact file is.
    for (const lane of known.filter((lane) => lane.cwd === cwd && lane.sessionFile !== null)) {
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
  }
  if (skipped) log(skipped)
  return { repositories: repositories.length, lanes: store.listLanes().length, added, removed }
}
