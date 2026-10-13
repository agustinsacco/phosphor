import type { HeartbeatResponse } from '@phosphor/shared/control-api'

export const AUTHORITY_LIMITS = { revocations: 1000, retentionMs: 15 * 60 * 1000 }

/** Missing heartbeat fields are no news, including missing revocations. */
export function createAuthority(now = Date.now) {
  let ownerId: string | undefined
  let epoch: number | undefined
  let removed = false
  const sessions = new Map<string, number>()
  const clients = new Map<string, number>()
  const listeners = new Set<() => void>()
  function prune(map: Map<string, number>) {
    for (const [id, seen] of map) if (now() - seen >= AUTHORITY_LIMITS.retentionMs) map.delete(id)
  }
  function remember(map: Map<string, number>, ids: readonly string[]) {
    prune(map)
    for (const id of ids) {
      map.delete(id)
      map.set(id, now())
    }
    while (map.size > AUTHORITY_LIMITS.revocations) {
      const first = map.keys().next().value
      if (first === undefined) break
      map.delete(first)
    }
  }
  return {
    snapshot() {
      prune(sessions)
      prune(clients)
      return !removed && ownerId !== undefined && epoch !== undefined
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
        remember(sessions, reply.revoked.sessions)
        remember(clients, reply.revoked.clients)
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
