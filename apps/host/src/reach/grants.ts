/**
 * Machine reach, caller side: one machine grant per target from control
 * (`POST /hosts/self/machine-grants`, signed with the machine key). Cached per
 * target for at most five minutes and reused until a minute before expiry,
 * single-flight, through host-client's grant cache.
 */
import { createGrantCache } from '@phosphor/host-client/grant-cache'
import {
  CONTROL_MACHINE_ROUTES,
  parseGrantIssueResponse,
  parseMachineGrantIssueRequest,
  type MachineGrantIssueResponse,
} from '@phosphor/shared/control-api'
import { ControlFailure } from '../control/client-response'
import type { ReachBudget, ReachControlStage } from '@phosphor/session-runtime/ops/reach'
import { controlStage, createReachRequester, type ReachControlPorts } from './control'

/** No grant is held longer than this, whatever control says. */
export const REACH_GRANT_TTL_MS = 300_000

/** Why control would not issue a grant, in the words a lane reads. */
export type ReachGrantRefusal =
  'signed-out' | 'reach-off' | 'unavailable' | 'unknown' | ReachControlStage

export class ReachGrantRefused extends Error {
  constructor(readonly reason: ReachGrantRefusal) {
    super(`Machine grant refused (${reason}).`)
  }
}

function refusal(error: unknown): ReachGrantRefusal {
  if (!(error instanceof ControlFailure)) return controlStage(error)
  switch (error.code) {
    case 'gone':
    case 'unauthenticated':
      return 'signed-out'
    case 'forbidden':
      return 'reach-off'
    case 'conflict':
      return 'unavailable'
    case 'not-found':
      return 'unknown'
    case 'too-many-requests':
      return 'rate-limited'
    default:
      return controlStage(error)
  }
}

export function createReachGrants(ports: ReachControlPorts) {
  const now = ports.now ?? Date.now
  const request = createReachRequester(ports)
  const cache = createGrantCache<MachineGrantIssueResponse, MachineGrantIssueResponse, ReachBudget>(
    {
      now,
      present: () => ports.control() !== null,
      async issue(targetHostId, _current, budget) {
        const control = ports.control()
        const body = parseMachineGrantIssueRequest({ targetHostId })
        if (!control) throw new ReachGrantRefused('signed-out')
        if (!body.ok) throw new ReachGrantRefused('unknown')
        try {
          return await request(
            control,
            {
              method: 'POST',
              path: CONTROL_MACHINE_ROUTES.hostMachineGrants,
              body: JSON.stringify(body.value),
              parse: parseGrantIssueResponse,
            },
            budget,
          )
        } catch (error) {
          throw new ReachGrantRefused(refusal(error))
        }
      },
      readGrant(targetHostId, reply) {
        if (reply.host.id !== targetHostId) throw new ReachGrantRefused('unknown')
        const cap = now() + REACH_GRANT_TTL_MS
        const expiresAt = Math.min(Date.parse(reply.expiresAt), cap)
        return { ...reply, expiresAt: new Date(expiresAt).toISOString() }
      },
    },
  )
  return {
    /** A grant to `targetHostId`, or `ReachGrantRefused`. */
    async grantFor(targetHostId: string, budget?: ReachBudget): Promise<MachineGrantIssueResponse> {
      try {
        return await cache.grantFor(targetHostId, budget)
      } catch (error) {
        if (error instanceof ReachGrantRefused) throw error
        throw new ReachGrantRefused('signed-out')
      }
    },
    clear: (targetHostId?: string) => cache.clear(targetHostId),
  }
}

export type ReachGrants = ReturnType<typeof createReachGrants>
