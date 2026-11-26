import { OpRefusal } from './builtins'
import { firstLine } from './completion'
import { orderDeferred } from './deferred'
import type { Judged } from './judge'
import type { PipelineEnv } from './pipeline'
import type { LaneDeferred, OpHandlerResult } from './types'

const REFUSED_RELOAD = {
  live: 'This lane cannot reload while sub-agent work is live; the change applies on its next reload.',
  again:
    'This lane already reloaded since the user’s last message; the change applies on its next reload.',
}

/** The self-reload rule: one per user prompt, never under live sub-agent work. */
export function reloadPlan(env: PipelineEnv, j: Judged, out: OpHandlerResult) {
  const items = out.deferred ?? []
  if (j.spec.applies !== 'reload' || !j.self || j.principal.kind !== 'agent')
    return { items, note: '' }
  const withoutReload = items.filter((item) => item.kind !== 'reload')
  const account = items.some((i) => i.kind === 'account')
  if (account && j.lane?.facts?.subagentsLive) throw new OpRefusal('busy', REFUSED_RELOAD.live)
  if (j.lane?.facts?.subagentsLive) return { items: withoutReload, note: REFUSED_RELOAD.live }
  if (!env.deferred.claimReload(j.principal.sessionId)) {
    if (account) throw new OpRefusal('busy', REFUSED_RELOAD.again)
    return { items: withoutReload, note: REFUSED_RELOAD.again }
  }
  if (account) return { items: withoutReload, note: '', terminate: true as const }
  const reload: LaneDeferred = { kind: 'reload', what: firstLine(out.text) || j.spec.name }
  return {
    items: items.some((item) => item.kind === 'reload') ? items : [...items, reload],
    note: '',
    terminate: true as const,
  }
}

/** The asking lane's own work waits for its run; another lane's waits only while it runs. */
export async function placeDeferred(
  env: PipelineEnv,
  j: Judged,
  items: readonly LaneDeferred[],
): Promise<void> {
  if (items.length === 0) return
  const own = j.self && j.principal.kind === 'agent' ? j.principal.sessionId : null
  const sessionId = own ?? j.lane?.sessionId ?? null
  if (sessionId === null) {
    env.deps.log('ops', 'deferred work has no lane', { op: j.spec.name })
    return
  }
  if (own !== null || j.lane?.busy) {
    env.deferred.hold(sessionId, items)
    return
  }
  const outcome = await env.binding.deferred.apply(sessionId, orderDeferred(items))
  if (!outcome.ok)
    env.deps.log('ops', 'deferred work did not apply', {
      op: j.spec.name,
      message: outcome.message,
    })
}
