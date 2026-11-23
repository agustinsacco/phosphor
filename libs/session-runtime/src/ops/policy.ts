/**
 * The agent policy as the dispatcher applies it. Pure functions over a
 * resolved tier and scope; the policy itself comes from the owner's
 * `PolicyStore`. Order matters and is the dispatcher's: `gateVerdict` (kill
 * switch, never tier, surface-only), then user-off and limits, then
 * `policyVerdict` (allow, ask or deny). Surfaces are the signed-in user and
 * skip every step here. Living contract: docs/agent-control.md ("Policy and
 * confirmations").
 */
import type { OpsDenyCode } from '@phosphor/shared/host-protocol-ops'
import { AGENT_POLICY_DEFAULT } from '@phosphor/shared/ops'
import type {
  AgentPolicy,
  AuditDecision,
  OpClass,
  OpScope,
  OpTier,
  PolicyDecision,
} from '@phosphor/shared/ops'
import type { GovernedAs } from './principals'

export type PolicyVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'ask' }
  | {
      readonly kind: 'deny'
      readonly code: OpsDenyCode
      readonly decision: AuditDecision
      readonly text: string
    }

/** What the policy steps look at for one op. */
export interface PolicyCheck {
  readonly op: string
  readonly tier: OpTier
  readonly scope: OpScope
  readonly class?: OpClass
  readonly surfaceOnly?: true
  readonly governed: GovernedAs
  readonly policy: AgentPolicy
}

type Level = AgentPolicy['agentControl']
const LEVEL_RANK: Record<Level, number> = { all: 0, read: 1, off: 2 }
const DECISION_RANK: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 }

const deny = (code: OpsDenyCode, decision: AuditDecision, text: string): PolicyVerdict => ({
  kind: 'deny',
  code,
  decision,
  text,
})

/** The policy level a non-surface principal is held to; `service` ops (Brain) ignore the kill switch. */
function levelFor(check: PolicyCheck): { level: Level; text: string } | null {
  if (check.governed === 'machine')
    return { level: check.policy.machineOps, text: 'Other machines’ agents' }
  if (check.governed === 'surface' || check.class === 'service') return null
  return { level: check.policy.agentControl, text: 'Agent control' }
}

/** Kill switch, never tier and surface-only, before any user-off, limit or confirmation lookup. */
export function gateVerdict(check: PolicyCheck): PolicyVerdict | null {
  if (check.governed === 'surface') return null
  const level = levelFor(check)
  if (level?.level === 'off')
    return deny('policy', 'denied-policy', `${level.text} is off on this machine.`)
  if (level?.level === 'read' && check.tier !== 'read')
    return deny('policy', 'denied-policy', `${level.text} is read-only on this machine.`)
  if (check.tier === 'never')
    return deny('never', 'denied-never', `${check.op} is not available to agents.`)
  if (check.surfaceOnly)
    return deny('forbidden', 'denied-policy', `Only the user can run ${check.op} from Phosphor.`)
  return null
}

export function stricterDecision(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b
}

/**
 * Ops whose `target` argument names a lane (its folder, checkout or PRs). The
 * judge resolves it like `ref`, and a write into another lane's folder asks.
 * `ui.open`'s target is a view, not a lane.
 */
export const LANE_TARGET_OPS: ReadonlySet<string> = new Set(
  `files.list files.read files.search files.write files.create files.mkdir files.trash files.rename
 files.transfer git.info git.status git.diff git.show git.branches git.worktrees git.fetch git.pull
 git.updateFromMain git.commitAll git.checkout git.renameBranch git.restoreFile git.merge pr.list
 pr.status pr.detail`.split(/\s+/),
)

/** Destructive ops ask, everything else is allowed (and audited). */
export function defaultDecision(tier: Exclude<OpTier, 'never'>): PolicyDecision {
  return tier === 'destructive' ? 'ask' : 'allow'
}

/**
 * A tier entry only tightens. An op entry may relax a destructive op to allow,
 * except on another lane: stopping, archiving, deleting or rewinding someone
 * else's lane, or writing into its folder, always asks at least.
 */
export function policyDecision(check: Omit<PolicyCheck, 'governed'>): PolicyDecision {
  if (check.tier === 'never') return 'deny'
  const byTier = check.policy.tiers?.[check.tier]
  const otherLane = check.scope === 'other-lane' && check.tier !== 'read'
  const otherLaneWrite = otherLane && LANE_TARGET_OPS.has(check.op)
  const base = stricterDecision(
    otherLaneWrite ? 'ask' : defaultDecision(check.tier),
    byTier ?? 'allow',
  )
  const byOp = check.policy.ops?.[check.op]
  if (byOp === undefined) return base
  return otherLaneWrite || (otherLane && check.tier === 'destructive')
    ? stricterDecision(base, byOp)
    : byOp
}

/** The decision for a principal that passed the gate, user-off and limits. */
export function policyVerdict(check: PolicyCheck): PolicyVerdict {
  if (check.governed === 'surface') return { kind: 'allow' }
  const decision = policyDecision(check)
  if (decision === 'deny')
    return deny(
      'policy',
      'denied-policy',
      `The agent policy on this machine does not allow ${check.op}.`,
    )
  return { kind: decision }
}

const stricterLevel = (a: Level, b: Level): Level => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b)

function stricterTiers(a: AgentPolicy, b: AgentPolicy): AgentPolicy['tiers'] {
  const out: Partial<Record<Exclude<OpTier, 'never'>, PolicyDecision>> = {}
  for (const tier of [
    'read',
    'lane',
    'create',
    'configure',
    'persistence',
    'destructive',
  ] as const) {
    const left = a.tiers?.[tier]
    const right = b.tiers?.[tier]
    if (left === undefined && right === undefined) continue
    out[tier] = stricterDecision(left ?? 'allow', right ?? 'allow')
  }
  return out
}

/** One-sided op entries survive only as `deny`: anything else could be the side that relaxed. */
function stricterOps(a: AgentPolicy, b: AgentPolicy): Record<string, PolicyDecision> {
  const out: Record<string, PolicyDecision> = {}
  for (const op of new Set([...Object.keys(a.ops ?? {}), ...Object.keys(b.ops ?? {})])) {
    const left = a.ops?.[op]
    const right = b.ops?.[op]
    if (left !== undefined && right !== undefined) out[op] = stricterDecision(left, right)
    else if (left === 'deny' || right === 'deny') out[op] = 'deny'
  }
  return out
}

/** A missing limit is the default, so a one-sided higher limit cannot survive. */
function stricterLimits(a: AgentPolicy, b: AgentPolicy): NonNullable<AgentPolicy['limits']> {
  const out: Record<string, number> = {}
  for (const key of ['lanesPer10Min', 'lineageDepth', 'opsPerMinute'] as const) {
    const fallback = AGENT_POLICY_DEFAULT.limits?.[key] ?? 0
    out[key] = Math.min(a.limits?.[key] ?? fallback, b.limits?.[key] ?? fallback)
  }
  return out
}

/**
 * Key by key, the stricter of two policies: what an owner enforces when its
 * policy file and its own last-written snapshot disagree.
 */
export function stricterPolicy(a: AgentPolicy, b: AgentPolicy): AgentPolicy {
  const tiers = stricterTiers(a, b)
  const ops = stricterOps(a, b)
  return {
    version: 1,
    agentControl: stricterLevel(a.agentControl, b.agentControl),
    machineOps: stricterLevel(a.machineOps, b.machineOps),
    ...(tiers && Object.keys(tiers).length > 0 ? { tiers } : {}),
    ...(Object.keys(ops).length > 0 ? { ops } : {}),
    limits: stricterLimits(a, b),
  }
}
