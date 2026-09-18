import { registry } from '../registry'
import { clearDraft } from '../store'
import { deleteDraftBlobs } from '../drafts-blobs'
import { forgetSpawnAccount } from './session-accounts'
import { deleteSession } from './session-deleter'
import { cancelSessionOpens, sessionPathKey, withSessionPath } from './session-path-lock'
import { isRoutineSession } from '../routines/ownership'

/** Stop every writer before trashing. A live handle needs no transcript to delete. */
export async function deleteLane(path?: string, sessionId?: string): Promise<string[]> {
  const target = sessionId ? registry.get(sessionId) : undefined
  // Main's identity wins over a renderer snapshot taken before a fork or bootstrap.
  const file = target?.client.sessionFile ?? path
  const run = async (): Promise<string[]> => {
    const matches = registry
      .list()
      .filter(
        (s) =>
          s.sessionId === sessionId ||
          (file && s.diskPath && sessionPathKey(s.diskPath) === sessionPathKey(file)),
      )
    // Keep references: a bootstrap response can arrive while disposal drains.
    const clients = matches
      .map((s) => registry.get(s.sessionId)?.client)
      .filter((c) => c !== undefined)
    for (const session of matches) {
      if (isRoutineSession(session.sessionId)) {
        const { cancelRoutineSession } = await import('../routines')
        await cancelRoutineSession(session.sessionId)
      }
    }
    for (const session of matches) {
      await registry.dispose(session.sessionId)
      forgetSpawnAccount(session.sessionId)
    }
    const paths = new Set(
      [file, ...clients.map((c) => c.sessionFile)].filter((p): p is string => Boolean(p)),
    )
    const disposed = matches.map((s) => s.sessionId)
    for (const transcript of paths) {
      if (!file) {
        // The first get_state may have arrived during shutdown. Acquire its
        // path lock now and stop any resume that got there before us.
        disposed.push(...(await deleteLane(transcript)))
      } else {
        await deleteSession(transcript)
        await deleteDraftBlobs(clearDraft(`session:${transcript}`))
      }
    }
    return disposed
  }
  if (file) cancelSessionOpens(file)
  return file ? withSessionPath(file, run) : run()
}
