import type { SessionMeta } from '@shared/models'
import {
  RATE_LIMIT_STATUS_KEY,
  parseRateLimit,
  type ClaudeRateLimit,
} from '@/features/chat/composer/rateLimit'

/**
 * What running this many lanes at once is costing.
 *
 * Two numbers the sidebar cannot show, because neither belongs to any one
 * lane: what the project has spent, and which account limit will stop you
 * first. The second is the one that actually bites — six lanes on a frontier
 * model burn the 5-hour window in ninety minutes, and today you find out when
 * a turn dies mid-edit.
 */

/** Each live pi subprocess measured ~200 MB RSS. Labelled as an estimate. */
export const MB_PER_LIVE_SESSION = 200

/**
 * The binding rate limit across live sessions.
 *
 * The limit is per ACCOUNT, not per session, so every session on the Claude
 * provider reports the same constraint — but they report it at different
 * moments, and a session that has not taken a turn since the window rolled
 * carries a stale reading. Taking the highest utilization is what makes the
 * meter agree with the next request rather than with the oldest one.
 *
 * Sessions on other providers never push this key at all, so a mixed fleet
 * simply contributes nothing here instead of reading as 0%.
 */
export function bindingRateLimit(
  statuses: Record<string, Record<string, string> | undefined>,
  sessionIds: readonly string[],
): ClaudeRateLimit | null {
  let binding: ClaudeRateLimit | null = null
  for (const id of sessionIds) {
    const limit = parseRateLimit(statuses[id]?.[RATE_LIMIT_STATUS_KEY])
    if (!limit) continue
    // A capped window is binding whatever the percentages say.
    if (limit.status === 'rejected') return limit
    if (!binding) {
      binding = limit
      continue
    }
    if ((limit.utilization ?? -1) > (binding.utilization ?? -1)) binding = limit
  }
  return binding
}

/** Resident memory held by live pi subprocesses. An estimate, never a claim. */
export function estimatedResidentMb(liveCount: number): number {
  return liveCount * MB_PER_LIVE_SESSION
}

/** "1.2 GB" / "600 MB" — the unit the number deserves. */
export function formatMb(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`
}

/**
 * The lanes that cost the most, biggest first.
 *
 * Over every lane of the project, not only the ones the board draws: a lane
 * that finished yesterday and cost $9 is exactly the one worth seeing, and it
 * has no card because there is nothing left to do about it.
 */
export function topSpenders(lanes: readonly SessionMeta[], limit = 4): SessionMeta[] {
  return lanes
    .filter((meta) => meta.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit)
}
