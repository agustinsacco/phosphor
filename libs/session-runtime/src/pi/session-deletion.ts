import { sessionPathKey, type SessionPathRuntime } from './session-path-lock'
import type { SessionRegistry } from './session-registry'

export interface SessionDeletionRuntime {
  registry: Pick<SessionRegistry, 'get' | 'list' | 'dispose'>
  paths: SessionPathRuntime
  ownsRoutine: (id: string) => boolean
  cancelRoutine: (id: string) => Promise<void>
  forgetAccount: (id: string) => void
  deleteTranscript: (path: string) => Promise<void>
  deleteDraft: (path: string) => Promise<void>
  /**
   * Throw to refuse, before any session stops or any file goes. It runs
   * inside the path lock, after any resume already under way, so nothing can
   * start between this check and the deletion. Desktop sets none.
   */
  assertDeletable?: (sessionId: string) => void
}

/** Share the creator's lock domain. Storage/trash policy belongs to the machine adapter. */
export function createSessionDeletion(runtime: SessionDeletionRuntime) {
  const { registry, paths } = runtime
  return async function deleteLane(path?: string, sessionId?: string): Promise<string[]> {
    const target = sessionId ? registry.get(sessionId) : undefined
    // Main's identity wins over a client snapshot taken before a fork or bootstrap.
    const file = target?.client.sessionFile ?? path
    const pending = [{ file, sessionId }]
    // Includes queued and visited keys, so aliases and identity cycles are processed once.
    const scheduled = new Set(file ? [sessionPathKey(file)] : [])
    const disposed: string[] = []
    for (const entry of pending) {
      const run = () => deletePath(runtime, entry.file, entry.sessionId)
      if (entry.file) paths.cancelSessionOpens(entry.file)
      const result = entry.file ? await paths.withSessionPath(entry.file, run) : await run()
      disposed.push(...result.disposed)
      // Never acquire another path lock until the current transaction has released its lock.
      for (const discovered of result.discovered) {
        const key = sessionPathKey(discovered)
        if (scheduled.has(key)) continue
        scheduled.add(key)
        pending.push({ file: discovered, sessionId: undefined })
      }
    }
    return disposed
  }
}

/** Stop the current owners; only trash transcripts protected by this transaction's lock. */
async function deletePath(runtime: SessionDeletionRuntime, file?: string, sessionId?: string) {
  const { registry } = runtime
  const key = file ? sessionPathKey(file) : undefined
  const matches = registry
    .list()
    .filter(
      (s) => s.sessionId === sessionId || (key && s.diskPath && sessionPathKey(s.diskPath) === key),
    )
  // Keep references: a bootstrap response can arrive while disposal drains.
  const clients = matches
    .map((s) => registry.get(s.sessionId)?.client)
    .filter((c) => c !== undefined)
  for (const session of matches) runtime.assertDeletable?.(session.sessionId)
  for (const session of matches) {
    if (runtime.ownsRoutine(session.sessionId)) await runtime.cancelRoutine(session.sessionId)
  }
  for (const session of matches) {
    await registry.dispose(session.sessionId)
    runtime.forgetAccount(session.sessionId)
  }
  const transcripts = new Map<string, string>()
  for (const transcript of [file, ...clients.map((c) => c.sessionFile)]) {
    if (transcript && !transcripts.has(sessionPathKey(transcript))) {
      transcripts.set(sessionPathKey(transcript), transcript)
    }
  }
  const discovered: string[] = []
  for (const [transcriptKey, transcript] of transcripts) {
    if (transcriptKey !== key) {
      discovered.push(transcript)
    } else {
      await runtime.deleteTranscript(transcript)
      await runtime.deleteDraft(transcript)
    }
  }
  return { disposed: matches.map((s) => s.sessionId), discovered }
}
