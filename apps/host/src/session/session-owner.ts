import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'

interface RegisteredSession {
  readonly sessionId: string
  readonly diskPath?: string | null
}

/**
 * The live pi that owns a transcript, if any. A pi that exited stays registered until
 * the lane resumes; it owns nothing, so a crashed lane is not "starting or stopping".
 */
export function sessionOwnerOf(
  sessions: readonly RegisteredSession[],
  path: string,
  alive: (sessionId: string) => boolean,
): string | undefined {
  const key = sessionPathKey(path)
  return sessions.find(
    (session) =>
      alive(session.sessionId) && !!session.diskPath && sessionPathKey(session.diskPath) === key,
  )?.sessionId
}
