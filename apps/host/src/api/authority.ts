import type { HeartbeatResponse } from '@phosphor/shared/control-api'

export const AUTHORITY_LIMITS = {
  revocations: 1000,
  retentionMs: 15 * 60 * 1000,
  /** Machine-origin sockets at once, so siblings cannot crowd out the owner's surfaces. */
  machineConnections: 16,
}

/**
 * Missing heartbeat fields are no news, including missing revocations.
 *
 * A live revocation is never evicted. A heartbeat whose new ids do not fit
 * closes the authority instead, until at least `retentionMs` after the last
 * batch that did not fit, and then until a complete heartbeat (owner, epoch and
 * revocations) fits. Reads never reopen it, so neither silence nor expiry does.
 *
 * Machine-origin grants are admitted only while the Host opts in (it serves
 * ops and its policy lets other machines in) and the last heartbeat that named
 * control's reach switch did not turn it off.
 */
export function createAuthority(now = Date.now) {
  let ownerId: string | undefined
  let epoch: number | undefined
  let removed = false
  let overflowUntil: number | undefined
  const sessions = new Map<string, number>()
  const clients = new Map<string, number>()
  const listeners = new Set<() => void>()
  function notify() {
    for (const listener of listeners) listener()
  }
  const machine = machineAdmission(notify)
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
            ...(machine.open() ? { machineOrigin: true as const } : {}),
          }
        : null
    },
    accept(reply: HeartbeatResponse) {
      if (reply.ownerId !== undefined) ownerId = reply.ownerId
      if (reply.epoch !== undefined) epoch = reply.epoch
      machine.heard(reply)
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
      notify()
    },
    remove() {
      removed = true
      notify()
    },
    ...machine.port,
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
export type Authority = ReturnType<typeof createAuthority>

/** The machine-origin opt-in and socket slots: only machine grants consult them. */
function machineAdmission(notify: () => void) {
  let machineOps = false
  let machineReach: boolean | undefined
  let sockets = 0
  return {
    open: () => machineOps && machineReach !== false,
    /** A beat that leaves the switch out is no news. */
    heard(reply: HeartbeatResponse) {
      if (reply.machineReach !== undefined) machineReach = reply.machineReach
    },
    port: {
      /** The Host's side of the opt-in: ops are served and local policy lets other machines in. */
      setMachineOps(enabled: boolean) {
        if (machineOps === enabled) return
        machineOps = enabled
        notify()
      },
      /** The heartbeat's `machineGrants`: the Host's side only, without control's switch. */
      machineGrants: () => machineOps,
      /** Holds one machine-origin socket slot; null at the cap. The release is idempotent. */
      admitMachine(): (() => void) | null {
        if (sockets >= AUTHORITY_LIMITS.machineConnections) return null
        sockets++
        let held = true
        return () => {
          if (held) sockets--
          held = false
        }
      },
    },
  }
}
