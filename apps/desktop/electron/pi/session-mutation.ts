import { access } from 'node:fs/promises'
import { registry } from '../registry'
import { isRoutineSession, routineSessionForPath } from '../routines/ownership'
import { sessionPathKey, withSessionPath } from './session-path-lock'

/**
 * Phosphor's own edits to pi's transcripts (labels, branch jumps, forks) run
 * inside the singleton path lock that resume and deletion already share, so
 * none of the three can interleave with an edit. The lock and the owner check
 * are process-local: a pi started outside Phosphor is not seen.
 */

const OPEN = 'This session is still open. Close it before editing its history.'
const ROUTINE =
  'This lane is owned by a running routine. Cancel it from Routines before editing its history.'
const MISSING = 'This session no longer exists. It may have been deleted.'

/**
 * Any registered lane on the file is an owner: a disposing one stays listed
 * until its process has exited. A routine's claim is recorded under the
 * spelling pi reported, so both spellings are asked.
 */
function assertNoOwner(path: string): void {
  const key = sessionPathKey(path)
  if (routineSessionForPath(path) ?? routineSessionForPath(key)) throw new Error(ROUTINE)
  for (const session of registry.list()) {
    if (!session.diskPath || sessionPathKey(session.diskPath) !== key) continue
    throw new Error(isRoutineSession(session.sessionId) ? ROUTINE : OPEN)
  }
}

/** An append recreates a missing file, so a deletion queued first must stop the edit here. */
async function assertExists(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(MISSING)
  }
}

/**
 * Write to the transcript at `path` itself. Refuses, rather than stopping the
 * owner, while any lane in this process owns the file.
 */
export function withOfflineSessionMutation<T>(path: string, write: () => Promise<T>): Promise<T> {
  return withSessionPath(path, async () => {
    assertNoOwner(path)
    await assertExists(path)
    return write()
  })
}

/**
 * Read the transcript at `path` into a brand-new file. A live owner does not
 * stop it, because the source is never written; the writer copies complete
 * lines only. The new file's fresh id is unknown to anyone until `fork`
 * returns, so it needs no lock of its own.
 */
export function withSessionForkSource<T>(path: string, fork: () => Promise<T>): Promise<T> {
  return withSessionPath(path, async () => {
    await assertExists(path)
    return fork()
  })
}
