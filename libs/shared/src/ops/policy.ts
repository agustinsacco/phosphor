/**
 * Agent policy, the audit row and the pending-confirmation view. The policy
 * itself is in the never tier for agents: only a signed-in user changes it.
 * Reached through `../ops`.
 */
import type { ConfirmItem, OpApplies } from '../host-protocol-ops'
import { isOpName } from '../host-protocol-ops'
import { integer, member, record } from '../host-protocol/primitives'
import { OP_TIERS, type OpScope, type OpTier } from './types'

export type PolicyDecision = 'allow' | 'ask' | 'deny'
const DECISIONS = ['allow', 'ask', 'deny'] as const
const POLICY_TIERS = OP_TIERS.filter((t): t is Exclude<OpTier, 'never'> => t !== 'never')
const LEVELS = ['all', 'read', 'off'] as const

export interface AgentPolicy {
  readonly version: 1
  /** `off` is the kill switch for this machine's own lanes. */
  readonly agentControl: 'all' | 'read' | 'off'
  /** What other machines' agents may do here. */
  readonly machineOps: 'all' | 'read' | 'off'
  readonly tiers?: Partial<Record<Exclude<OpTier, 'never'>, PolicyDecision>>
  readonly ops?: Readonly<Record<string, PolicyDecision>>
  readonly limits?: {
    readonly lanesPer10Min?: number
    readonly lineageDepth?: number
    readonly opsPerMinute?: number
  }
}

export const AGENT_POLICY_DEFAULT: AgentPolicy = {
  version: 1,
  agentControl: 'all',
  machineOps: 'all',
  limits: { lanesPer10Min: 10, lineageDepth: 2, opsPerMinute: 120 },
}

export const AGENT_POLICY_LIMITS = { ops: 500, limitMax: 10_000 } as const

function tiers(v: unknown): AgentPolicy['tiers'] | null {
  if (!record(v)) return null
  const out: Partial<Record<Exclude<OpTier, 'never'>, PolicyDecision>> = {}
  for (const [tier, decision] of Object.entries(v)) {
    if (!member(tier, POLICY_TIERS) || !member(decision, DECISIONS)) return null
    out[tier] = decision
  }
  return out
}

function ops(v: unknown): Record<string, PolicyDecision> | null {
  if (!record(v) || Object.keys(v).length > AGENT_POLICY_LIMITS.ops) return null
  const out: Record<string, PolicyDecision> = {}
  for (const [op, decision] of Object.entries(v)) {
    if (!isOpName(op) || !member(decision, DECISIONS)) return null
    out[op] = decision
  }
  return out
}

function limits(v: unknown): AgentPolicy['limits'] | null {
  if (!record(v)) return null
  const out: Record<string, number> = {}
  for (const key of ['lanesPer10Min', 'lineageDepth', 'opsPerMinute'] as const) {
    const value = v[key]
    if (value === undefined) continue
    if (!integer(value) || value > AGENT_POLICY_LIMITS.limitMax) return null
    out[key] = value
  }
  return out
}

/** Null for any invalid field: the caller falls back to the stricter of default and file. */
export function parseAgentPolicy(v: unknown): AgentPolicy | null {
  if (!record(v) || v.version !== 1) return null
  if (!member(v.agentControl, LEVELS) || !member(v.machineOps, LEVELS)) return null
  const t = v.tiers === undefined ? undefined : tiers(v.tiers)
  const o = v.ops === undefined ? undefined : ops(v.ops)
  const l = v.limits === undefined ? undefined : limits(v.limits)
  if (t === null || o === null || l === null) return null
  return {
    version: 1,
    agentControl: v.agentControl,
    machineOps: v.machineOps,
    ...(t ? { tiers: t } : {}),
    ...(o ? { ops: o } : {}),
    ...(l ? { limits: l } : {}),
  }
}

export type AuditDecision =
  | 'allowed'
  | 'approved'
  | 'denied-user'
  | 'timeout'
  | 'denied-policy'
  | 'denied-never'
  | 'denied-limit'
  | 'denied-user-off'
  | 'denied-unattended'
  | 'aborted'

/** One audit row. Sensitive args are already redacted in `argsSummary`. */
export interface AgentOpRow {
  readonly id: string
  readonly at: number
  /** `kind:id` of the principal, e.g. `machine:<machineId>`. */
  readonly principal: string
  readonly laneRef?: string
  readonly laneTitle?: string
  readonly op: string
  readonly tier: OpTier
  readonly scope: OpScope
  readonly target?: string
  readonly argsSummary: string
  readonly reason?: string
  readonly decision: AuditDecision
  readonly result: string
  readonly applies?: OpApplies
  readonly undo: boolean
  readonly undoneBy?: string
}

/** A pending or settled ask, as `confirm.info`, `confirm.list` and `confirm.status` show it. */
export interface ConfirmInfo {
  readonly confirmId: string
  readonly digest: string
  readonly state: 'pending' | 'approved' | 'denied' | 'expired'
  /** For `not-controller` style asks, the message names the controlling client. */
  readonly origin: {
    readonly kind: 'agent' | 'machine' | 'local'
    readonly label: string
    readonly lane?: string
  }
  readonly op: string
  readonly title: string
  readonly message: string
  readonly reason?: string
  readonly items: readonly ConfirmItem[]
  readonly expiresAt: number
  readonly batchId?: string
  readonly dialogId?: string
}
