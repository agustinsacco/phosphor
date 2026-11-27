import { randomUUID } from 'node:crypto'
import { isInside } from '@phosphor/session-runtime/fs-safety'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import type { LeaseRefusal, OwnerCalls } from '@phosphor/shared/host-protocol-owner'
import { canonicalRemovedPath } from '../machine/repositories'
import { OwnerCallRefused, type OwnerHandlers } from './adapter'

type Use = Exclude<LeaseRefusal, 'busy'>
interface Lease {
  owner: string
  paths: string[]
  ttlMs: number
  expires: number
}
interface Occupant {
  workspacePath: string
  reason?: Use
}
export class WorkspaceLeased extends Error {}

/** One admission domain per local runtime. The check and reservation never yield. */
export class WorkspaceLeases {
  private readonly held = new Map<string, Lease>()
  private readonly starting = new Set<Occupant>()
  constructor(
    private readonly live: () => readonly Occupant[],
    private readonly now: () => number,
  ) {}

  private prune() {
    const now = this.now()
    for (const [id, lease] of this.held) if (lease.expires <= now) this.held.delete(id)
  }

  /** Read-only availability hint; a mutation must still acquire the lease. */
  blocks(path: string): boolean {
    const overlaps = (p: string) => isInside(p, path) || isInside(path, p)
    return (
      [...this.held.values()].some(
        (lease) => lease.expires > this.now() && lease.paths.some(overlaps),
      ) ||
      [...this.starting, ...this.live()].some((entry) =>
        overlaps(sessionPathKey(entry.workspacePath)),
      )
    )
  }

  async take(
    owner: string,
    paths: readonly string[],
    ttlMs: number,
  ): Promise<OwnerCalls['owner.lease.take']['result']> {
    const keys = await Promise.all(paths.map(canonicalRemovedPath))
    this.prune()
    const occupants = [...this.starting, ...this.live()]
    for (const [i, key] of keys.entries()) {
      const path = paths[i]!
      for (const lease of this.held.values()) {
        if (lease.paths.some((p) => isInside(p, key) || isInside(key, p)))
          return { refused: 'busy', path }
      }
      const occupied = occupants.find((row) => isInside(key, sessionPathKey(row.workspacePath)))
      if (occupied) return { refused: occupied.reason ?? 'live-lane', path }
    }
    const leaseId = randomUUID()
    this.held.set(leaseId, { owner, paths: keys, ttlMs, expires: this.now() + ttlMs })
    return { leaseId }
  }

  renew(owner: string, leaseId: string) {
    this.prune()
    const lease = this.held.get(leaseId)
    if (lease?.owner !== owner) return { ok: false }
    lease.expires = this.now() + lease.ttlMs
    return { ok: true }
  }

  release(owner: string, leaseId: string) {
    if (this.held.get(leaseId)?.owner === owner) this.held.delete(leaseId)
    return { ok: true as const }
  }

  async withUse<T>(path: string, reason: Use, run: () => Promise<T>): Promise<T> {
    const workspacePath = await canonicalRemovedPath(path)
    this.prune()
    for (const lease of this.held.values()) {
      if (lease.paths.some((p) => isInside(p, workspacePath)))
        throw new WorkspaceLeased('This workspace is leased by Phosphor Desktop.')
    }
    const entry = { workspacePath, reason }
    this.starting.add(entry)
    try {
      return await run()
    } finally {
      this.starting.delete(entry)
    }
  }
}

export function createWorkspaceLeases(live: () => readonly Occupant[], now = Date.now) {
  return new WorkspaceLeases(live, now)
}

export function leaseHandlers(current: () => WorkspaceLeases | undefined): OwnerHandlers {
  const active = () => {
    const leases = current()
    if (!leases) throw new OwnerCallRefused('forbidden', "Lanes on this Mac aren't running yet.")
    return leases
  }
  return {
    'owner.lease.take': async ({ paths, ttlMs }, { client }) =>
      active().take(client.id, paths, ttlMs),
    'owner.lease.renew': async ({ leaseId }, { client }) => active().renew(client.id, leaseId),
    'owner.lease.release': async ({ leaseId }, { client }) => active().release(client.id, leaseId),
  }
}
