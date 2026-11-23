/**
 * Work an op leaves for after the lane's run: model, thinking, compaction,
 * reload, stop and archive. Held per pi session until `settled`, then handed to
 * the owner's `deferred.apply` once, in a fixed order (model changes first, so
 * a reload starts on the new model). Also tracks the one self-reload a lane
 * gets per user prompt. Living contract: docs/agent-control.md.
 */
import type { RuntimeLog } from '../file-log'
import type { LaneDeferred, OpsBinding } from './types'

const ORDER: readonly LaneDeferred['kind'][] = [
  'model',
  'thinking',
  'autoCompaction',
  'autoRetry',
  'steering',
  'follow-up',
  'compact',
  'reload',
  'stop',
  'archive',
]

/**
 * One item per kind: a later model, thinking level or compaction replaces the
 * earlier one, reload reasons join, stop and archive collapse.
 */
export function orderDeferred(items: readonly LaneDeferred[]): LaneDeferred[] {
  const byKind = new Map<LaneDeferred['kind'], LaneDeferred>()
  for (const item of items) {
    const prior = byKind.get(item.kind)
    if (item.kind === 'reload' && prior?.kind === 'reload' && prior.what !== item.what)
      byKind.set('reload', { kind: 'reload', what: `${prior.what}; ${item.what}` })
    else byKind.set(item.kind, item)
  }
  return ORDER.flatMap((kind) => {
    const item = byKind.get(kind)
    return item ? [item] : []
  })
}

export interface LaneDeferredQueue {
  /** Holds items until the session's run settles. */
  hold(sessionId: string, items: readonly LaneDeferred[]): void
  pending(sessionId: string): readonly LaneDeferred[]
  /** True, and recorded, when this run may end on a self reload; false after one since the last user prompt. */
  claimReload(sessionId: string): boolean
  /** A user prompt, steer or follow-up: the lane gets one more self reload. */
  userPrompted(sessionId: string): void
  /** The run settled: apply what was held, once. */
  settled(sessionId: string): Promise<void>
  /** Stop or exit: drop everything held for the session. */
  cancel(sessionId: string): void
}

export function createLaneDeferred(
  binding: Pick<OpsBinding, 'deferred'>,
  log: RuntimeLog,
): LaneDeferredQueue {
  const held = new Map<string, LaneDeferred[]>()
  const reloaded = new Set<string>()
  return {
    hold(sessionId, items) {
      if (items.length === 0) return
      held.set(sessionId, [...(held.get(sessionId) ?? []), ...items])
    },
    pending: (sessionId) => orderDeferred(held.get(sessionId) ?? []),
    claimReload(sessionId) {
      if (reloaded.has(sessionId)) return false
      reloaded.add(sessionId)
      return true
    },
    userPrompted(sessionId) {
      reloaded.delete(sessionId)
    },
    async settled(sessionId) {
      const items = orderDeferred(held.get(sessionId) ?? [])
      held.delete(sessionId)
      if (items.length === 0) return
      try {
        const outcome = await binding.deferred.apply(sessionId, items)
        if (!outcome.ok)
          log('ops', 'deferred work did not apply', { sessionId, message: outcome.message })
      } catch (error) {
        log('ops', 'deferred work failed', { sessionId, error: String(error) })
      }
    },
    cancel(sessionId) {
      held.delete(sessionId)
      reloaded.delete(sessionId)
    },
  }
}
