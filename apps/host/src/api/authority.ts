import type { HeartbeatResponse } from '@phosphor/shared/control-api'

export const AUTHORITY_LIMITS = { revocations: 1000, retentionMs: 15 * 60 * 1000 }

/**
 * Missing heartbeat fields are no news, including missing revocations.
 *
 * A live revocation is never evicted. A heartbeat whose new ids do not fit
 * closes the authority instead, until at least `retentionMs` after the last
 * batch that did not fit, and then until a complete heartbeat (owner, epoch and
 * revocations) fits. Reads never reopen it, so neither silence nor expiry does.
 */
export function createAuthority(now = Date.now) {
  let ownerId: string | undefined
  let epoch: number | undefined
  let removed = false
  let overflowUntil: number | undefined
  const sessions = new Map<string, number>()
  const clients = new Map<string, number>()
  const listeners = new Set<() => void>()
  function prune(map: Map<string, number>) {
    for (const [id, seen] of map) if (now() - seen >= AUTHORITY_LIMITS.retentionMs) map.delete(id)
  }
  /** False when a new id did not fit. A known id refreshes without using capacity. */
  function remember(map: Map<string, number>, ids: readonly string[]) {
    prune(map)
    let fits = true
    for (const id of ids) {
      const seen = map.get(id)
      // A backward clock step must not shorten a retained revocation.
      if (seen !== undefined) map.set(id, Math.max(seen, now()))
      else if (map.size < AUTHORITY_LIMITS.revocations) map.set(id, now())
      else fits = false
    }
    return fits
  }
  return {
    snapshot() {
      prune(sessions)
      prune(clients)
      return !removed && overflowUntil === undefined && ownerId !== undefined && epoch !== undefined
        ? {
            owner: ownerId,
            epoch,
            revokedSessions: new Set(sessions.keys()),
            revokedClients: new Set(clients.keys()),
          }
        : null
    },
    accept(reply: HeartbeatResponse) {
      if (reply.ownerId !== undefined) ownerId = reply.ownerId
      if (reply.epoch !== undefined) epoch = reply.epoch
      if (reply.revoked) {
        const sessionsFit = remember(sessions, reply.revoked.sessions)
        const clientsFit = remember(clients, reply.revoked.clients)
        if (!sessionsFit || !clientsFit)
          overflowUntil = Math.max(overflowUntil ?? -Infinity, now() + AUTHORITY_LIMITS.retentionMs)
        else if (
          overflowUntil !== undefined &&
          now() >= overflowUntil &&
          reply.ownerId !== undefined &&
          reply.epoch !== undefined
        )
          overflowUntil = undefined
      }
      for (const listener of listeners) listener()
    },
    remove() {
      removed = true
      for (const listener of listeners) listener()
    },
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
export type Authority = ReturnType<typeof createAuthority>
