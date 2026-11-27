/**
 * What the dispatcher answers itself: `policy.show`, `confirm.status` (only
 * for the principal that created the confirmation), the exact items an asked
 * op lists, and `OpRefusal`, the in-band refusal any handler may throw.
 * Living contract: docs/agent-control.md ("Policy and confirmations").
 */
import type { ConfirmItem, OpsDenyCode } from '@phosphor/shared/host-protocol-ops'
import type { AgentPolicy } from '@phosphor/shared/ops'
import type { Judged } from './judge'
import type { OpsDispatcherDeps } from './ports'
import type { OpHandler, OpsBinding } from './types'

/** Thrown by a handler to answer `{status:'denied', code, text}` instead of an error. */
export class OpRefusal extends Error {
  constructor(
    readonly code: OpsDenyCode,
    text: string,
  ) {
    super(text)
    this.name = 'OpRefusal'
  }
}

function describePolicy(policy: AgentPolicy, changedOutside: boolean): string {
  const lines = [
    `Agent control: ${policy.agentControl}.`,
    `Other machines’ agents: ${policy.machineOps}.`,
  ]
  const tiers = Object.entries(policy.tiers ?? {})
  if (tiers.length > 0) lines.push(`Tiers: ${tiers.map(([t, d]) => `${t} ${d}`).join(', ')}.`)
  const ops = Object.entries(policy.ops ?? {})
  if (ops.length > 0) lines.push(`Operations: ${ops.map(([o, d]) => `${o} ${d}`).join(', ')}.`)
  if (changedOutside)
    lines.push('The policy was changed outside Phosphor; the stricter setting applies.')
  return lines.join('\n')
}

export function builtinHandlers(
  binding: Pick<OpsBinding, 'policy'>,
  deps: Pick<OpsDispatcherDeps, 'confirms'>,
): Readonly<Record<string, OpHandler>> {
  return {
    'policy.show': async () => {
      const { policy, changedOutside } = await binding.policy.read()
      return { text: describePolicy(policy, changedOutside), data: { policy, changedOutside } }
    },
    'confirm.status': async (args, ctx) => {
      const confirmId = (args as { confirmId: string }).confirmId
      const info = await deps.confirms.status(confirmId, ctx.principal)
      if (!info)
        throw new OpRefusal('forbidden', `No confirmation ${confirmId} that you asked for.`)
      return { text: `Confirmation ${confirmId.slice(0, 8)}: ${info.state}.`, data: info }
    },
  }
}

/** Exact ids an asked op acts on, with lane titles where an id names a lane here. */
export function confirmItems(
  binding: Pick<OpsBinding, 'machineId' | 'lanes'>,
  j: Judged,
): ConfirmItem[] {
  const a = j.args
  const ids = Array.isArray(a.ids)
    ? a.ids.filter((id): id is string => typeof id === 'string')
    : a.all === true
      ? ['all']
      : [
          typeof a.ref === 'string' ? (j.lane?.ref ?? a.ref) : a.ref,
          a.lane,
          a.key,
          a.id,
          a.name,
          j.spec.name.startsWith('worktree.') && typeof a.path === 'string' && a.path.length > 128
            ? undefined
            : a.path,
        ]
          .filter((v): v is string => typeof v === 'string')
          .slice(0, 1)
  const label = (id: string) => {
    const title = id === j.lane?.ref ? j.lane.title : binding.lanes.resolve(id)?.title
    return (title?.trim() || id).slice(0, 200)
  }
  return [{ hostId: binding.machineId, op: j.spec.name, ids, labels: ids.map(label) }]
}
