import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionMeta, WorkspaceSessionStats } from '@shared/models'
import { compareSessionsByCreation } from '@shared/session-order'
import { sessionDirForCwd } from './pi-paths'
import {
  cloneFold,
  emptyFold,
  foldFrom,
  metaFromFold,
  readSignature,
  type FoldState,
} from './session-fold'

export { piAgentDir, piSessionsRoot, sessionDirForCwd, sessionDirNameForCwd } from './pi-paths'

/**
 * On-disk session discovery — drives the sidebar and home stats without
 * spawning pi processes. The directory layout itself lives in `pi-paths.ts`,
 * and the parse itself in `session-fold.ts`.
 */

interface CacheEntry {
  mtimeMs: number
  size: number
  /**
   * `null` for a file with no `type: "session"` header, and cached as such
   * ON PURPOSE. A null result used to be left out of the cache, so every one
   * of those files was fully re-parsed on EVERY scan rather than only when it
   * changed. MEASURED: 5 of 112 real session files here have no header, and
   * one of them is 3.2 MB — re-read in full on every sidebar refresh of that
   * workspace, forever. "This file has nothing to show" is an answer worth
   * remembering.
   */
  meta: SessionMeta | null
}

/**
 * State needed to continue a parse instead of restarting it: where the last
 * one stopped, proof the file was appended to rather than rewritten, and the
 * running totals.
 */
interface ResumeEntry {
  consumedBytes: number
  signature: string
  state: FoldState
}

/**
 * Metadata for every session ever scanned. Bounded because this process runs
 * for days: it used to be a plain Map that also kept entries for deleted
 * files forever.
 */
const METAS_CACHED = 512

/**
 * Resumable parses. Deliberately far smaller than METAS_CACHED — a resume
 * entry holds a `seenParents` set that grows with the transcript (~400 KB for
 * a 3.6 MB session), and only files being appended to can use one. A handful
 * covers every session actually live at once; a cold session that never
 * changes never needs one.
 */
const RESUMES_CACHED = 16

/** Insertion-ordered Map used as an LRU: re-set on hit, evict from the front. */
function touch<V>(cache: Map<string, V>, key: string, value: V, cap: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > cap) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

const metaCache = new Map<string, CacheEntry>()
const resumeCache = new Map<string, ResumeEntry>()

/** Test seam: drop every cached parse. */
export function clearSessionCaches(): void {
  metaCache.clear()
  resumeCache.clear()
}

export async function listSessions(workspacePath: string): Promise<SessionMeta[]> {
  return listSessionsInDir(sessionDirForCwd(workspacePath))
}

async function listSessionsInDir(dir: string): Promise<SessionMeta[]> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  const present = new Set(files.map((file) => join(dir, file)))
  const metas = await Promise.all(
    files.map(async (file) => {
      const path = join(dir, file)
      try {
        const info = await stat(path)
        const cached = metaCache.get(path)
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
          touch(metaCache, path, cached, METAS_CACHED)
          return cached.meta
        }
        const meta = await scanSessionFile(path, info.mtimeMs, info.size)
        touch(metaCache, path, { mtimeMs: info.mtimeMs, size: info.size, meta }, METAS_CACHED)
        return meta
      } catch {
        return null
      }
    }),
  )

  // A session deleted from this directory must not keep its entry alive. Only
  // paths under `dir` are considered, so other workspaces are untouched.
  for (const path of [...metaCache.keys()]) {
    if (path.startsWith(dir) && !present.has(path)) {
      metaCache.delete(path)
      resumeCache.delete(path)
    }
  }

  return metas.filter((m): m is SessionMeta => m !== null).sort(compareSessionsByCreation)
}

/**
 * Parse a session file, continuing a previous parse when the file has only
 * grown since.
 *
 * The append is PROVEN, not assumed: the bytes ending where the last parse
 * stopped are re-read and compared. A rewrite, a truncation, or anything else
 * that moves that boundary falls back to a full parse, so the worst case is
 * the old cost and never a wrong answer.
 */
async function scanSessionFile(
  path: string,
  mtimeMs: number,
  size: number,
): Promise<SessionMeta | null> {
  const resume = resumeCache.get(path)
  // `size > consumedBytes` is load-bearing, not an optimization. Reaching here
  // means the file changed, so a file that did NOT grow was rewritten in
  // place — and a same-length rewrite can leave the last 64 bytes untouched,
  // which the signature alone would read as "nothing happened" and answer
  // with stale totals. Requiring new bytes sends that case to a full parse.
  if (resume && size > resume.consumedBytes) {
    const signature = await readSignature(path, resume.consumedBytes)
    if (signature === resume.signature) {
      // Fold into a copy: a throw partway through would otherwise leave the
      // cached totals double-counted for every later turn.
      const state = cloneFold(resume.state)
      try {
        const consumedBytes = await foldFrom(path, resume.consumedBytes, state)
        return await remember(path, mtimeMs, state, consumedBytes)
      } catch {
        // Fall through to the full parse below.
      }
    }
  }
  resumeCache.delete(path)

  const state = emptyFold()
  const consumedBytes = await foldFrom(path, 0, state)
  return remember(path, mtimeMs, state, consumedBytes)
}

async function remember(
  path: string,
  mtimeMs: number,
  state: FoldState,
  consumedBytes: number,
): Promise<SessionMeta | null> {
  const meta = metaFromFold(state, path, mtimeMs)
  if (!meta) return null
  const signature = await readSignature(path, consumedBytes)
  if (signature !== null) {
    touch(resumeCache, path, { consumedBytes, signature, state }, RESUMES_CACHED)
  }
  return meta
}

/** Single-pass parse of a whole file. Kept for callers outside the scan loop. */
export async function parseSessionFile(path: string, mtimeMs: number): Promise<SessionMeta | null> {
  const state = emptyFold()
  await foldFrom(path, 0, state)
  return metaFromFold(state, path, mtimeMs)
}

/**
 * Aggregate stats for the workspace home screen (tiles + heatmap).
 */
export async function workspaceStats(workspacePath: string): Promise<WorkspaceSessionStats> {
  const sessions = await listSessions(workspacePath)
  const activityByDay = new Map<string, number>()
  let messages = 0
  let tokens = 0
  let totalCost = 0
  let savedTokens = 0

  for (const session of sessions) {
    messages += session.userMessages + session.assistantMessages
    tokens += session.totalTokens
    totalCost += session.cost
    savedTokens += session.headroomSavedTokens
    const day = session.lastActivityAt.slice(0, 10)
    if (day)
      activityByDay.set(
        day,
        (activityByDay.get(day) ?? 0) + session.userMessages + session.assistantMessages,
      )
    const created = session.createdAt.slice(0, 10)
    if (created && created !== day) {
      activityByDay.set(created, (activityByDay.get(created) ?? 0) + 1)
    }
  }

  return {
    sessionCount: sessions.length,
    messages,
    tokens,
    cost: totalCost,
    savedTokens,
    activeDays: activityByDay.size,
    activityByDay: Object.fromEntries(activityByDay),
  }
}

export { readSessionTree } from './session-tree'
