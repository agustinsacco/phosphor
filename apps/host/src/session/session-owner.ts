import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'

interface RegisteredSession {
  readonly sessionId: string
  readonly diskPath?: string | null
}

/**
 * The pi that owns a transcript, if any: running, or stopping and not yet exited. A pi
 * that crashed stays registered until the lane resumes; it owns nothing, so a crashed
 * lane is not "starting or stopping".
 */
export interface SessionOwner {
  readonly sessionId: string
  /** Stop sent, pi not exited yet. Otherwise it is running or still starting. */
  readonly stopping: boolean
}

export function sessionOwnerOf(
  sessions: readonly RegisteredSession[],
  path: string,
  state: { alive: (sessionId: string) => boolean; stopping: (sessionId: string) => boolean },
): SessionOwner | undefined {
  const key = sessionPathKey(path)
  const owner = sessions.find(
    (session) =>
      (state.alive(session.sessionId) || state.stopping(session.sessionId)) &&
      !!session.diskPath &&
      sessionPathKey(session.diskPath) === key,
  )
  return owner && { sessionId: owner.sessionId, stopping: state.stopping(owner.sessionId) }
}
