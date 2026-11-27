import type { LaneEffect } from '@phosphor/shared/ops'
import { authenticatedLane } from './principals'
import type { Judged } from './judge'
import type { PipelineEnv } from './pipeline'
import type { LaneDeferred, OpHandlerResult } from './types'
import { undoRecordFor } from './undo'

/** Bind approval to the controller fence that was shown, not just to the target lane id. */
export function confirmationArgs(j: Judged) {
  if (j.spec.name === 'lane.message')
    return { ...j.args, sender: authenticatedLane(j.principal), controlFence: j.lane?.controlFence }
  return j.lane?.controlFence !== undefined &&
    ['lane.stop', 'lane.archive', 'lane.delete'].includes(j.spec.name)
    ? { ...j.args, controlFence: j.lane.controlFence }
    : j.args
}
export function inverse(env: PipelineEnv, j: Judged, out: OpHandlerResult) {
  if (out.undo === false || out.deferred?.some((i) => i.action)) return null
  const record = undoRecordFor(j.spec, j.args, out.before, (op) => env.specs.get(op))
  return record && out.fingerprint ? { ...record, fingerprint: out.fingerprint } : record
}
export function completed(
  env: PipelineEnv,
  j: Judged,
  id: string | undefined,
  out: OpHandlerResult,
) {
  if (id) env.binding.audit.complete?.(id, j.spec.name, out.text, inverse(env, j, out))
}

export function afterAudit(
  env: PipelineEnv,
  j: Judged,
  auditId: string | undefined,
  items: readonly LaneDeferred[],
) {
  return items.map((item) => {
    const action = item.action
    return !action
      ? item
      : {
          ...item,
          action: async () => {
            const result = await action()
            completed(env, j, auditId, result)
            return result
          },
        }
  })
}

export const firstLine = (text: string): string => text.split('\n', 1)[0]?.slice(0, 160) ?? ''

/** The one toast an allowed change makes in the asking lane, unless the handler made its own. */
export function withToast(
  j: Judged,
  effects: readonly LaneEffect[],
  text: string,
): readonly LaneEffect[] {
  if (j.principal.kind !== 'agent' || j.tier === 'read') return effects
  if (effects.some((e) => e.kind === 'notify' || e.kind === 'swarm')) return effects
  // A governed agent write carries a reason (the judge refuses one without it).
  const reason = j.request.reason?.trim()
  const why = reason ? ` Reason: ${firstLine(reason)}` : ''
  const message = `Agent ran ${j.spec.name}: ${firstLine(text)}${why}`.slice(0, 200)
  return [...effects, { kind: 'notify', message, level: 'info' }]
}
