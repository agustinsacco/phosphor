import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { errnoIs } from '../../fs-safety'
import type { ScanState } from '../reconcile'
import { LaneCapacityReached, type HostStore } from '../store'

const HEADER_BYTES = 8192

export async function hasHeader(file: string, cwd: string): Promise<boolean> {
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

export async function removeMissingSessions(
  store: HostStore,
  state: ScanState,
  signal?: AbortSignal,
): Promise<void> {
  // A scan failure is not proof of deletion. Only ENOENT on the exact file is.
  for (const lane of state.known) {
    if (!state.repositories.some((repository) => repository.id === lane.repositoryId)) continue
    signal?.throwIfAborted()
    if (lane.sessionFile === null) continue
    try {
      await lstat(lane.sessionFile)
    } catch (error) {
      if (error instanceof Error && errnoIs(error, 'ENOENT')) {
        store.markRemoved(lane.laneId)
        state.removed++
      } else state.skipped++
    }
  }
}

async function admitSession(
  store: HostStore,
  state: ScanState,
  file: string,
  cwd: string,
  repositoryId: string,
): Promise<void> {
  const existing = store.sessionLane(file)
  if (existing?.removedAt === null) return
  if (state.liveLanes >= store.limits.lanesPerHost) {
    state.admissionsFull = true
    state.skipped++
    return
  }
  try {
    if (!(await hasHeader(file, cwd))) {
      state.skipped++
      return
    }
    let storedCwd = cwd
    if (existing) {
      if (existing.repositoryId !== repositoryId || (await realpath(existing.cwd)) !== cwd) {
        state.skipped++
        return
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
      worktree: !state.repositories.some((repository) => repository.path === cwd),
    })
    if (!wasLive) {
      state.liveLanes++
      state.added++
    }
  } catch (error) {
    state.skipped++
    if (error instanceof LaneCapacityReached) state.admissionsFull = true
  }
}

async function admitFolder(
  store: HostStore,
  state: ScanState,
  directory: string,
  cwd: string,
  repositoryId: string,
  signal?: AbortSignal,
): Promise<void> {
  let entries = 0
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      state.skipped++
      return
    }
    const dir = await opendir(directory)
    for await (const entry of dir) {
      signal?.throwIfAborted()
      if (++entries > HOST_LIMITS.lanesPerHost * 2) {
        state.skipped++
        break
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      await admitSession(store, state, join(directory, entry.name), cwd, repositoryId)
      if (state.admissionsFull) break
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (!(error instanceof Error && errnoIs(error, 'ENOENT'))) state.skipped++
  }
}

export async function admitSessions(
  store: HostStore,
  state: ScanState,
  sessionsRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const [cwd, repositoryId] of state.folders) {
    if (state.admissionsFull) break
    signal?.throwIfAborted()
    await admitFolder(store, state, sessionDirForCwd(cwd, sessionsRoot), cwd, repositoryId, signal)
  }
}
