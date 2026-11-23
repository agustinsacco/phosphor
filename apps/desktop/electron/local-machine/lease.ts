import { ownerCall } from '@phosphor/host-client/owner'
import type { LeaseRefusal } from '@phosphor/shared/host-protocol-owner'
import { sameMachine, type SameMachineView } from './same-machine'

/**
 * A workspace lease on This Mac's service (`owner.lease.*`): while Desktop
 * holds one, the service refuses lane start, resume, routine start and
 * archive restore in those folders, and it refuses the lease over a live
 * lane. In daemon mode it replaces Desktop's in-app registry check before a
 * checkout is removed, restored or recreated.
 */

export const WORKSPACE_LEASE_TTL_MS = 60_000

export const LOCAL_SERVICE_UNAVAILABLE =
  "This Mac's Phosphor service isn't connected, so the checkout was kept."

export const LEASE_REFUSED: Record<LeaseRefusal, string> = {
  'live-lane': 'Suspend all sessions before removing this checkout.',
  routine: 'A routine is starting in this checkout. Try again when it has started.',
  archive: 'A lane in this checkout is being restored from the archive. Try again shortly.',
  busy: 'Phosphor is already changing this checkout.',
}

export class WorkspaceLeaseRefused extends Error {
  constructor(
    readonly refusal: LeaseRefusal | 'unavailable',
    readonly path?: string,
  ) {
    super(refusal === 'unavailable' ? LOCAL_SERVICE_UNAVAILABLE : LEASE_REFUSED[refusal])
    this.name = 'WorkspaceLeaseRefused'
  }
}

export interface WorkspaceLease {
  /** False once a renewal failed or the lease may have expired: stop before changing anything. */
  held(): boolean
}

export interface WorkspaceLeasePorts {
  service?: () => SameMachineView | undefined
  now?: () => number
  ttlMs?: number
}

/**
 * Runs `run` while `paths` are leased, renewing every third of the TTL, and
 * releases the lease afterwards. Refuses with `WorkspaceLeaseRefused` when
 * the service is not connected or will not lease every path.
 */
export async function withWorkspaceLease<T>(
  paths: readonly string[],
  run: (lease: WorkspaceLease) => Promise<T>,
  ports: WorkspaceLeasePorts = {},
): Promise<T> {
  const view = (ports.service ?? sameMachine)()
  if (!view) throw new WorkspaceLeaseRefused('unavailable')
  const { connection } = view
  const now = ports.now ?? Date.now
  const ttlMs = ports.ttlMs ?? WORKSPACE_LEASE_TTL_MS
  const asked = now()
  const taken = await ownerCall(connection, 'owner.lease.take', { paths: [...paths], ttlMs })
  if ('refused' in taken) throw new WorkspaceLeaseRefused(taken.refused, taken.path)
  const { leaseId } = taken
  let expires = asked + ttlMs
  let lost = false
  const timer = setInterval(
    () => {
      const sent = now()
      ownerCall(connection, 'owner.lease.renew', { leaseId }).then(
        (renewed) => {
          if (renewed.ok) expires = Math.max(expires, sent + ttlMs)
          else lost = true
        },
        () => {
          lost = true
        },
      )
    },
    Math.floor(ttlMs / 3),
  )
  timer.unref()
  try {
    return await run({ held: () => !lost && now() < expires })
  } finally {
    clearInterval(timer)
    // An unanswered release costs nothing: the service drops the lease at its TTL.
    ownerCall(connection, 'owner.lease.release', { leaseId }).catch(() => undefined)
  }
}
