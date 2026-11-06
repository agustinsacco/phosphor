import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { isWithinFolder } from '@phosphor/shared/paths'
import { brainOwnerFromEntry } from '@phosphor/session-runtime/pi/brain-session-owner'
import type { BrainServiceOptions } from './service-types'
import type { DesktopMemoryClient } from './memory-client'

const MAX_TRANSCRIPT = 2_000_000
export async function readOwnedTranscript(
  path: string,
  jobId: string,
  sessionDir: string,
): Promise<string> {
  const root = await realpath(sessionDir)
  if (!isWithinFolder(resolve(path), root)) throw new Error('Unsafe Brain processor transcript')
  const resolved = await realpath(path)
  const stat = await lstat(path)
  if (
    !isWithinFolder(resolved, root) ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > MAX_TRANSCRIPT
  )
    throw new Error('Unsafe Brain processor transcript')
  const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (info.size > MAX_TRANSCRIPT) throw new Error('Brain transcript exceeds limit')
    const buffer = Buffer.alloc(MAX_TRANSCRIPT + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_TRANSCRIPT) throw new Error('Brain transcript exceeds limit')
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const entries = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const owners = entries.filter(
      (entry) => entry.type === 'custom' && entry.customType === 'phosphor-brain-owner',
    )
    if (!owners.length || owners.some((entry) => brainOwnerFromEntry(entry)?.jobId !== jobId))
      throw new Error('Brain transcript ownership mismatch')
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
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
