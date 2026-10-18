/**
 * Unseen predicate for sidebar rows: a session has unseen activity when we
 * have a seen-marker for it AND its last activity is newer than that marker.
 *
 * A missing marker means "seen": prefs written before this feature existed
 * (or pruned entries) must not light up the whole sidebar.
 */

/** Slop absorbing writes pi makes while the session is still on screen. */
const SLOP_MS = 2_000

export function isUnseen(
  seenSessions: Record<string, number>,
  sessionPath: string,
  lastActivityAt: string | undefined,
): boolean {
  const seenAt = seenSessions[sessionPath]
  if (seenAt === undefined) return false
  if (!lastActivityAt) return false
  const activityMs = Date.parse(lastActivityAt)
  if (Number.isNaN(activityMs)) return false
  return activityMs > seenAt + SLOP_MS
}
