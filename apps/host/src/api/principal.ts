import type { GrantClient, GrantPayload, GrantPrincipal } from '@phosphor/shared/host-grant'
import type { OpsActor } from '@phosphor/shared/host-protocol-ops'
import type { HostCapability, HostHello } from '@phosphor/shared/remote-host'
import type { LaneCommandOrigin, OpPrincipal } from '@phosphor/session-runtime/ops/types'
import { grantedCapabilities } from './ready-frame'

/**
 * Who holds a connection. TCP connections carry a control-signed grant for a
 * user or another enrolled machine; the local socket carries the attested
 * owner (Desktop) or any other same-user process.
 */
export type ConnectionPrincipal =
  | { readonly kind: 'grant-user'; readonly clientId: string }
  | { readonly kind: 'grant-machine'; readonly clientId: string; readonly machineId: string }
  | { readonly kind: 'owner'; readonly clientId: string }
  /** `lane` is the caller's `PI_SESSION_ID`: attribution and a downgrade only. */
  | { readonly kind: 'local'; readonly clientId: string; readonly lane?: string }

/** What a `local` principal reads. It never controls lanes, terminals, routines or settings. */
export const LOCAL_CAPABILITIES: readonly HostCapability[] = [
  'sessions.read',
  'workspaces.read',
  'artifacts.read',
  'skills.read',
]

export function grantConnectionPrincipal(principal: GrantPrincipal): ConnectionPrincipal {
  return principal.kind === 'machine'
    ? { kind: 'grant-machine', clientId: principal.clientId, machineId: principal.machineId }
    : { kind: 'grant-user', clientId: principal.clientId }
}

/** No new capability names: nothing here is grantable, so control can never issue it. */
export function principalCapabilities(
  hello: HostHello,
  principal: ConnectionPrincipal,
  grant?: Pick<GrantPayload, 'caps' | 'configure'>,
): readonly HostCapability[] {
  switch (principal.kind) {
    case 'grant-user':
    case 'grant-machine':
      return grant ? grantedCapabilities(hello, grant) : []
    case 'owner':
      return [...hello.capabilities]
    case 'local':
      return hello.capabilities.filter((cap) => LOCAL_CAPABILITIES.includes(cap))
  }
}

/** The op principal a connection's `ops.run` runs as. An actor only attributes. */
export function opPrincipalFor(
  principal: ConnectionPrincipal,
  client: GrantClient,
  actor?: OpsActor,
): OpPrincipal {
  switch (principal.kind) {
    case 'grant-user':
      return { kind: 'surface', clientId: client.id, label: client.label, via: 'grant' }
    case 'owner':
      return { kind: 'surface', clientId: client.id, label: client.label, via: 'owner' }
    case 'grant-machine':
      return {
        kind: 'machine',
        machineId: principal.machineId,
        clientId: client.id,
        label: client.label,
        lane: actor?.lane ?? null,
      }
    case 'local':
      return {
        kind: 'local',
        clientId: client.id,
        ...(principal.lane !== undefined ? { lane: principal.lane } : {}),
      }
  }
}

/** Absent for a user grant, so today's lane command clients stay exactly as they were. */
export function laneCommandOrigin(
  principal: ConnectionPrincipal | undefined,
): LaneCommandOrigin | undefined {
  switch (principal?.kind) {
    case undefined:
    case 'grant-user':
      return undefined
    case 'owner':
      return 'surface'
    case 'grant-machine':
      return 'machine'
    case 'local':
      return 'local'
  }
}
