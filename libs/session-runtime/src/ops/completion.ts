import type { Judged } from './judge'
import type { PipelineEnv } from './pipeline'
import type { LaneDeferred, OpHandlerResult } from './types'
import { undoRecordFor } from './undo'

/** Bind approval to the controller fence that was shown, not just to the target lane id. */
export function confirmationArgs(j: Judged) {
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
