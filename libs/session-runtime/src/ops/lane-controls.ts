/**
 * The asking lane's own controls, shared by every owner: Swarm, PR tracking,
 * context files and notify answer as effects the lane's tool applies; model,
 * thinking, compaction, retry and queue changes wait for the run to end.
 * Living contract: docs/agent-control.md.
 */
import type { LaneEffect } from '@phosphor/shared/ops'
import { CONTEXT_FILE_KINDS, type ContextFilePrefs } from '@phosphor/shared/context-files'
import { OpRefusal } from './builtins'
import { op } from './results'
import type { LaneDeferred, LaneFacts, OpHandlerContext } from './types'

/** The lane an op is about; each owner refuses in its own words when there is none. */
export type TargetLane = (ctx: OpHandlerContext) => LaneFacts

/** The asking lane's own effect: only its tool can apply one. */
export function laneEffect(ctx: OpHandlerContext, text: string, effect: LaneEffect) {
  if (ctx.principal.kind !== 'agent' || ctx.lane?.sessionId !== ctx.principal.sessionId)
    throw new OpRefusal('bad-request', 'Run this operation inside the lane.')
  return { text, effects: [effect] }
}

/** `claude=on agents=off`: the context-files command's own argument form. */
export function contextFileArgs(args: Partial<ContextFilePrefs>): string {
  return CONTEXT_FILE_KINDS.filter((k) => args[k] !== undefined)
    .map((k) => `${k}=${args[k] ? 'on' : 'off'}`)
    .join(' ')
}

export function laneControlHandlers(targetLane: TargetLane) {
  const later = (ctx: OpHandlerContext, item: LaneDeferred) => {
    if (!targetLane(ctx).sessionId) throw new OpRefusal('unavailable', 'This lane is not running.')
    return { text: `Queued ${item.kind} for after this run.`, deferred: [item] }
  }
  const swarm = (enabled: boolean) =>
    op((_a, c) =>
      laneEffect(c, `Swarm ${enabled ? 'on' : 'off'}.`, {
        kind: 'swarm',
        enabled,
        reason: c.reason ?? 'Agent request',
      }),
    )
  const pr = (action: 'pin' | 'hide' | 'clear') =>
    op<{ url: string }>(({ url }, c) =>
      laneEffect(c, `PR ${action}: ${url}`, { kind: 'pr', action, url }),
    )
  return {
    'swarm.on': swarm(true),
    'swarm.off': swarm(false),
    'pr.track': pr('pin'),
    'pr.hide': pr('hide'),
    'pr.clear': pr('clear'),
    'contextFiles.set': op<Partial<ContextFilePrefs>>((a, c) => {
      const args = contextFileArgs(a)
      return laneEffect(c, args, { kind: 'contextFiles', args })
    }),
    notify: op<{ text: string }>(({ text }, c) =>
      laneEffect(c, 'Notified.', { kind: 'notify', message: `Agent: ${text}`, level: 'info' }),
    ),
    'model.set': op<{ model: string }>(({ model }, c) => {
      const i = model.indexOf('/')
      if (i <= 0 || i === model.length - 1)
        throw new OpRefusal('bad-request', 'Use provider/model.')
      return later(c, { kind: 'model', provider: model.slice(0, i), modelId: model.slice(i + 1) })
    }),
    'thinking.set': op<{ level: string }>(({ level }, c) => later(c, { kind: 'thinking', level })),
    'lane.compact': op<{ instructions?: string }>(({ instructions }, c) =>
      later(c, { kind: 'compact', instructions }),
    ),
    'lane.autoRetry': op<{ on: boolean }>(({ on }, c) =>
      later(c, { kind: 'autoRetry', enabled: on }),
    ),
    'lane.autoCompaction': op<{ on: boolean }>(({ on }, c) =>
      later(c, { kind: 'autoCompaction', enabled: on }),
    ),
    'lane.queueMode': op<{ queue: 'steering' | 'follow-up'; mode: 'all' | 'one-at-a-time' }>(
      ({ queue, mode }, c) => later(c, { kind: queue, mode }),
    ),
  }
}
