import { useState } from 'react'
import { Row, Select } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import {
  AGENT_POLICY_DEFAULT,
  AGENT_POLICY_LIMITS,
  OP_TIERS,
  type AgentPolicy,
  type PolicyDecision,
} from '@phosphor/shared/ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { runAgentOp } from './agentOps'
import { useOpAction } from './useOpRead'

const levels = [
  { value: 'all', label: 'All' },
  { value: 'read', label: 'Read only' },
  { value: 'off', label: 'Off' },
] as const
const decisions = [
  { value: '', label: 'Default' },
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
] as const
const ops = OP_CATALOG.filter(
  (s) => s.tier !== 'never' && !s.surfaceOnly && s.class !== 'service',
).map((s) => ({ value: s.name, label: s.name }))
type Save = (p: AgentPolicy) => void
function overrides(
  current: Readonly<Record<string, PolicyDecision>> | undefined,
  key: string,
  value: PolicyDecision | '',
) {
  const next = { ...current }
  if (value) next[key] = value
  else delete next[key]
  return next
}
function PolicyDetails({ policy, save }: { policy: AgentPolicy; save: Save }) {
  const [op, setOp] = useState(ops[0]!.value)
  return (
    <details>
      <TooltipSummary className="cursor-pointer">
        Tier defaults, individual operations and limits
      </TooltipSummary>
      {OP_TIERS.filter((t) => t !== 'never').map((tier) => (
        <Row key={tier} title={tier}>
          <Select
            options={decisions}
            value={policy.tiers?.[tier] ?? ''}
            onChange={(v) => save({ ...policy, tiers: overrides(policy.tiers, tier, v) })}
          />
        </Row>
      ))}
      <Row title="Individual operation">
        <Select value={op} options={ops} onChange={setOp} />
        <Select
          label={`Policy for ${op}`}
          value={policy.ops?.[op] ?? ''}
          options={decisions}
          onChange={(v) => save({ ...policy, ops: overrides(policy.ops, op, v) })}
        />
      </Row>
      {Object.entries(policy.ops ?? {}).map(([key, decision]) => (
        <p key={key}>
          {key}: {decision}
        </p>
      ))}
      <PolicyLimits policy={policy} save={save} />
    </details>
  )
}
const limits = {
  lanesPer10Min: 'Lane creations per 10 minutes',
  lineageDepth: 'Lane ancestry depth',
  opsPerMinute: 'Operations per minute',
} as const
function PolicyLimits({ policy, save }: { policy: AgentPolicy; save: Save }) {
  return Object.entries(limits).map(([key, title]) => {
    const k = key as keyof typeof limits
    const value = policy.limits?.[k] ?? AGENT_POLICY_DEFAULT.limits?.[k]
    return (
      <Row key={k} title={title}>
        <input
          className="bg-surface border-border w-24 rounded border px-2"
          aria-label={title}
          type="number"
          min={0}
          max={AGENT_POLICY_LIMITS.limitMax}
          key={value}
          defaultValue={value}
          onBlur={(e) => {
            const field = e.currentTarget
            if (field.value !== '' && field.validity.valid && field.valueAsNumber !== value)
              save({ ...policy, limits: { ...policy.limits, [k]: field.valueAsNumber } })
            else field.value = String(value)
          }}
        />
      </Row>
    )
  })
}
export function AgentPolicyForm({
  machine,
  policy,
  changedOutside,
  reload,
}: {
  machine: string
  policy: AgentPolicy
  changedOutside: boolean
  reload: () => void
}) {
  const action = useOpAction()
  const save: Save = (p) =>
    action.run(async () => {
      await runAgentOp(machine, 'policy.set', { policy: p })
      reload()
    })
  return (
    <fieldset disabled={action.busy}>
      <legend className="font-semibold">What the phosphor tool may do without asking</legend>
      {changedOutside && (
        <p role="status">The policy was changed outside Phosphor. The stricter settings apply.</p>
      )}
      <Row title="Agent control" description="What this machine’s agents may do.">
        <Select
          options={levels}
          value={policy.agentControl}
          onChange={(agentControl) => save({ ...policy, agentControl })}
        />
      </Row>
      <Row title="Other machines’ agents">
        <Select
          options={levels}
          value={policy.machineOps}
          onChange={(machineOps) => save({ ...policy, machineOps })}
        />
      </Row>
      <PolicyDetails policy={policy} save={save} />
      {action.error && <p role="alert">{action.error}</p>}
    </fieldset>
  )
}
