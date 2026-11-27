/**
 * How the dispatcher reads an `OpPrincipal`: the key its audit rows, queues and
 * limits use, and the class of policy that governs it. `actor` on a request and
 * `lane` on a `local` principal are attribution and a downgrade only: a surface
 * that names an agent actor is governed as an agent, and nothing gains authority
 * from them. Living contract: docs/agent-control.md ("Policy and confirmations").
 */
import { parseRemoteLaneKey } from '@phosphor/shared/remote-host'
import type { OpsRunRequest } from '@phosphor/shared/host-protocol-ops'
import type { ConfirmInfo } from '@phosphor/shared/ops'
import type { OpPrincipal } from './types'

/** The policy class an op is judged under. Only `surface` is the signed-in user. */
export type GovernedAs = 'surface' | 'agent' | 'machine' | 'local'

export type AgentPrincipal = Extract<OpPrincipal, { kind: 'agent' }>

/** `kind:id`, the audit row's `principal` and the key of every per-principal queue and limit. */
export function principalKey(principal: OpPrincipal): string {
  switch (principal.kind) {
    case 'surface':
      return `surface:${principal.clientId}`
    case 'agent':
      return `agent:${principal.laneRef}`
    case 'machine':
      return `machine:${principal.machineId}`
    case 'local':
      return `local:${principal.clientId}`
  }
}

/**
 * A machine principal is judged as another machine's agent whatever `actor`
 * says; a surface that sends `actor` is judged as that agent; an actor never
 * lifts an agent, machine or local principal to a surface.
 */
export function governedAs(
  principal: OpPrincipal,
  request: Pick<OpsRunRequest, 'actor'>,
): GovernedAs {
  if (principal.kind === 'surface') return request.actor ? 'agent' : 'surface'
  return principal.kind
}

/** The asking lane as attribution: the agent's own lane, or what the caller said. */
export function askingLane(
  principal: OpPrincipal,
  request: Pick<OpsRunRequest, 'actor'>,
): string | undefined {
  switch (principal.kind) {
    case 'agent':
      return principal.laneRef
    case 'machine':
      return principal.lane ?? request.actor?.lane
    case 'local':
      return principal.lane ?? request.actor?.lane
    case 'surface':
      return request.actor?.lane
  }
}

/** A routine run with no one watching cannot answer a confirmation. */
export function isUnattended(principal: OpPrincipal): boolean {
  return principal.kind === 'agent' && principal.unattended
}

/** A lane identity the owner can use for creator checks, not an arbitrary actor label. */
export function authenticatedLane(principal: OpPrincipal): string | undefined {
  if (principal.kind === 'agent') return principal.laneRef
  if (
    principal.kind === 'machine' &&
    principal.lane &&
    parseRemoteLaneKey(principal.lane)?.hostId === principal.machineId
  )
    return principal.lane
}

export const MESSAGE_SENDER_REQUIRED =
  'Only an authenticated agent lane can use lane message. To send a user message, use the normal prompt path.'

/** The pi session whose dialog a confirmation binds to; only an agent has one. */
export function askingSession(principal: OpPrincipal): string | null {
  return principal.kind === 'agent' ? principal.sessionId : null
}

/** Who a pending confirmation says asked. A surface with an actor shows as that agent. */
export function confirmOrigin(
  principal: OpPrincipal,
  request: Pick<OpsRunRequest, 'actor'>,
  laneTitle?: string,
): ConfirmInfo['origin'] {
  const lane = askingLane(principal, request)
  const withLane = lane === undefined ? {} : { lane }
  switch (principal.kind) {
    case 'agent':
      return { kind: 'agent', label: laneTitle ?? 'An agent lane', ...withLane }
    case 'machine':
      return { kind: 'machine', label: principal.label, ...withLane }
    case 'local':
      return { kind: 'local', label: 'Phosphor command line', ...withLane }
    case 'surface':
      return { kind: 'agent', label: request.actor?.title ?? principal.label, ...withLane }
  }
}
