/**
 * Agent op limits: ops per minute per principal, agent-created lanes per ten
 * minutes across the machine, and how deep agent-created lanes may nest.
 * In memory, per owner process: a restart forgets the windows, which only
 * ever loosens a limit for one window. Surfaces are never limited.
 * Living contract: docs/agent-control.md ("Policy and confirmations").
 */
import { AGENT_POLICY_DEFAULT, type AgentPolicy, type OpTier } from '@phosphor/shared/ops'
import type { PolicyVerdict } from './policy'

/** Ops that start a lane; they count toward `lanesPer10Min` when an agent runs them. */
export const LANE_CREATING_OPS: ReadonlySet<string> = new Set([
  'lane.create',
  'lane.fork',
  'lane.clone',
  'routine.run',
])

export type EffectiveLimits = Required<NonNullable<AgentPolicy['limits']>>

const MINUTE_MS = 60_000
const LANE_WINDOW_MS = 10 * MINUTE_MS

export function effectiveLimits(policy: AgentPolicy): EffectiveLimits {
  const fallback = AGENT_POLICY_DEFAULT.limits ?? {}
  return {
    lanesPer10Min: policy.limits?.lanesPer10Min ?? fallback.lanesPer10Min ?? 10,
    lineageDepth: policy.limits?.lineageDepth ?? fallback.lineageDepth ?? 2,
    opsPerMinute: policy.limits?.opsPerMinute ?? fallback.opsPerMinute ?? 120,
  }
}

export interface LimitCheck {
  /** `principalKey` of the caller. */
  readonly key: string
  readonly op: string
  readonly tier: OpTier
  /** Depth of agent-created lanes above the asking lane; null when the caller has no lane here. */
  readonly lineage: number | null
  readonly limits: EffectiveLimits
}

export interface OpLimits {
  /** Counts the op toward the caller's minute; a denial is not counted. */
  admit(check: LimitCheck): Extract<PolicyVerdict, { kind: 'deny' }> | null
  /** An agent op created a lane: count it toward the machine's ten-minute window. */
  laneCreated(): void
}

const limited = (text: string): Extract<PolicyVerdict, { kind: 'deny' }> => ({
  kind: 'deny',
  code: 'limit',
  decision: 'denied-limit',
  text,
})

/** Drops stamps older than the window and returns how many remain. */
function prune(stamps: number[], now: number, windowMs: number): number {
  let drop = 0
  while (drop < stamps.length && stamps[drop]! <= now - windowMs) drop++
  stamps.splice(0, drop)
  return stamps.length
}

export function createOpLimits(now: () => number = Date.now): OpLimits {
  const perPrincipal = new Map<string, number[]>()
  const lanes: number[] = []
  return {
    admit(check) {
      const at = now()
      const stamps = perPrincipal.get(check.key) ?? []
      if (prune(stamps, at, MINUTE_MS) >= check.limits.opsPerMinute)
        return limited(
          `Too many Phosphor operations; at most ${check.limits.opsPerMinute} a minute.`,
        )
      if (
        check.tier === 'create' &&
        check.lineage !== null &&
        check.lineage >= check.limits.lineageDepth
      )
        return limited(
          `This lane was started by an agent ${check.lineage} levels deep; it cannot start more work.`,
        )
      if (
        LANE_CREATING_OPS.has(check.op) &&
        prune(lanes, at, LANE_WINDOW_MS) >= check.limits.lanesPer10Min
      )
        return limited(
          `Agents started ${check.limits.lanesPer10Min} lanes on this machine in the last 10 minutes; wait before starting more.`,
        )
      stamps.push(at)
      perPrincipal.set(check.key, stamps)
      return null
    },
    laneCreated() {
      lanes.push(now())
    },
  }
}
