import { constants } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { isWithinFolder } from '@phosphor/shared/paths'
import { bounded } from './authority'
import {
  BRAIN_OWNER_CUSTOM_TYPE,
  brainOwnerFromEntry,
} from '@phosphor/session-runtime/pi/brain-session-owner'
import type { BrainServiceOptions } from './service-types'
import type { DesktopMemoryClient } from './memory-client'

const MAX_TRANSCRIPT = 2_000_000
/** Missing is safe only for the final leaf beneath real, existing owned parents. */
export async function plannedTranscriptExists(path: string, sessionDir: string): Promise<boolean> {
  const unsafe = () => new Error('Unsafe Brain processor transcript')
  if (
    typeof path !== 'string' ||
    path.length > 4096 ||
    !isAbsolute(path) ||
    path !== resolve(path) ||
    path.includes('\0')
  )
    throw unsafe()
  const root = await realpath(sessionDir).catch(() => {
    throw unsafe()
  })
  if (!isWithinFolder(path, root) || path === root) throw unsafe()
  const directory = await lstat(sessionDir).catch(() => {
    throw unsafe()
  })
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw unsafe()
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (parent !== root && dirname(parent) === parent) throw unsafe()
    const stat = await lstat(parent).catch(() => {
      throw unsafe()
    })
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(parent)) !== parent)
      throw unsafe()
    if (parent === root) break
  }
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return false
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > MAX_TRANSCRIPT ||
    (await realpath(path)) !== path
  )
    throw unsafe()
  return true
}

export function assertTranscriptOwnership(entries: unknown, jobId: string): void {
  if (!Array.isArray(entries) || entries.length > 4000)
    throw new Error('Brain transcript ownership unavailable')
  bounded(entries, MAX_TRANSCRIPT)
  const owners = entries.filter((entry: unknown): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Brain transcript ownership malformed')
    return (entry as Record<string, unknown>).customType === BRAIN_OWNER_CUSTOM_TYPE
  })
  if (!owners.length || owners.some((entry) => brainOwnerFromEntry(entry)?.jobId !== jobId))
    throw new Error('Brain transcript ownership mismatch')
}

export async function readOwnedTranscript(
  path: string,
  jobId: string,
  sessionDir: string,
): Promise<string> {
  if (!(await plannedTranscriptExists(path, sessionDir)))
    throw Object.assign(new Error('Brain processor transcript has not been written yet'), {
      code: 'ENOENT',
    })
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_TRANSCRIPT)
      throw new Error('Brain transcript exceeds limit')
    const buffer = Buffer.alloc(MAX_TRANSCRIPT + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_TRANSCRIPT) throw new Error('Brain transcript exceeds limit')
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const entries = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    assertTranscriptOwnership(entries, jobId)
    return text
  } finally {
    await file.close()
  }
}

export function createBrainTranscripts(
  options: BrainServiceOptions,
  store: DesktopMemoryClient,
  sessionDir: string,
  cancel: (jobId: string) => Promise<void>,
) {
  const checked = (path: string, jobId: string) => readOwnedTranscript(path, jobId, sessionDir)
  async function purge(): Promise<void> {
    for (const item of await store.pendingPurges()) {
      try {
        await cancel(item.jobId)
        options.sessionPaths.cancelSessionOpens(item.sessionPath)
        await options.sessionPaths.withSessionPath(item.sessionPath, async () => {
          for (const info of options.registry.list()) {
            const live = options.registry.get(info.sessionId)
            if (live?.owner?.jobId === item.jobId)
              await options.sessions.disposeBrain(live.sessionId, live.owner)
          }
          try {
            await checked(item.sessionPath, item.jobId)
            await unlink(item.sessionPath)
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
              (await plannedTranscriptExists(item.sessionPath, sessionDir))
            )
              throw error
          }
          await store.acknowledgePurge(item.jobId)
        })
      } catch (error) {
        options.onError?.(error)
      }
    }
  }
  return {
    checked,
    purge,
    async read(jobId: string) {
      const job = await store.job(jobId)
      if (!job.sessionPath) throw new Error('Brain processor transcript is unavailable')
      return options.sessionPaths.withSessionPath(job.sessionPath, () =>
        checked(job.sessionPath!, jobId),
      )
    },
  }
}
