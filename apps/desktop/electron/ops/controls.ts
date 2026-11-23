import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type {
  LaneDeferred,
  OpHandlerContext,
  OpsBinding,
} from '@phosphor/session-runtime/ops/types'
import type { LaneEffect } from '@phosphor/shared/ops'
import { CONTEXT_FILE_KINDS, type ContextFilePrefs } from '@shared/context-files'
import type { RpcCommand, ThinkingLevel } from '@shared/rpc'
import { broadcast } from '../broadcast'
import { lanePath, liveOpLane, localLaneRef, targetLane } from './lanes'
import { op } from './results'

async function command(id: string, rpc: RpcCommand) {
  const { desktopSessions } = await import('../pi/session-runtime')
  const result = await desktopSessions.command(id, rpc)
  if (!result.success)
    throw new OpRefusal('unavailable', result.error ?? 'pi refused this command.')
}
function deferredCommand(item: LaneDeferred): RpcCommand {
  switch (item.kind) {
    case 'model':
      return { type: 'set_model', provider: item.provider, modelId: item.modelId }
    case 'thinking':
      return { type: 'set_thinking_level', level: item.level as ThinkingLevel }
    case 'compact':
      return { type: 'compact', customInstructions: item.instructions }
    case 'autoRetry':
      return { type: 'set_auto_retry', enabled: item.enabled }
    case 'autoCompaction':
      return { type: 'set_auto_compaction', enabled: item.enabled }
    case 'steering':
      return { type: 'set_steering_mode', mode: item.mode }
    case 'follow-up':
      return { type: 'set_follow_up_mode', mode: item.mode }
    default:
      throw new Error('This Mac cannot apply that deferred operation.')
  }
}
export const deferred: OpsBinding['deferred'] = {
  async apply(id, items) {
    for (const item of items) {
      await command(id, deferredCommand(item))
      broadcast('ops:changed', {
        machine: 'local',
        kind: 'lane',
        laneRef: localLaneRef(id),
        fields: [item.kind],
      })
    }
    return { ok: true }
  },
}
function later(ctx: OpHandlerContext, item: LaneDeferred) {
  if (!targetLane(ctx).sessionId) throw new OpRefusal('unavailable', 'This lane is not running.')
  return { text: `Queued ${item.kind} for after this run.`, deferred: [item] }
}
function effect(ctx: OpHandlerContext, text: string, e: LaneEffect) {
  if (ctx.principal.kind !== 'agent' || ctx.lane?.sessionId !== ctx.principal.sessionId)
    throw new OpRefusal('bad-request', 'Run this operation inside the lane.')
  return { text, effects: [e] }
}
const swarm = (enabled: boolean) =>
  op((_a, c) =>
    effect(c, `Swarm ${enabled ? 'on' : 'off'}.`, {
      kind: 'swarm',
      enabled,
      reason: c.reason ?? 'Agent request',
    }),
  )
const pr = (action: 'pin' | 'hide' | 'clear') =>
  op<{ url: string }>(({ url }, c) =>
    effect(c, `PR ${action}: ${url}`, { kind: 'pr', action, url }),
  )
export const controlHandlers = {
  'swarm.on': swarm(true),
  'swarm.off': swarm(false),
  'pr.track': pr('pin'),
  'pr.hide': pr('hide'),
  'pr.clear': pr('clear'),
  'contextFiles.set': op<Partial<ContextFilePrefs>>((a, c) => {
    const args = CONTEXT_FILE_KINDS.filter((k) => a[k] !== undefined)
      .map((k) => `${k}=${a[k] ? 'on' : 'off'}`)
      .join(' ')
    return effect(c, args, { kind: 'contextFiles', args })
  }),
  notify: op<{ text: string }>(({ text }, c) =>
    effect(c, 'Notified.', { kind: 'notify', message: `Agent: ${text}`, level: 'info' }),
  ),
  'model.set': op<{ model: string }>(({ model }, c) => {
    const i = model.indexOf('/')
    if (i <= 0 || i === model.length - 1) throw new OpRefusal('bad-request', 'Use provider/model.')
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
function markChanged(c: OpHandlerContext, field: string) {
  const l = targetLane(c)
  broadcast('ops:changed', { machine: 'local', kind: 'lane', laneRef: l.ref, fields: [field] })
  broadcast('sessions:changed', { workspacePath: l.cwd })
}
export const markHandlers = {
  'lane.rename': op<{ name: string }>(async ({ name }, c) => {
    const l = targetLane(c)
    if (!l.sessionId) throw new OpRefusal('unavailable', 'Resume the lane to rename it.')
    await command(l.sessionId, { type: 'set_session_name', name })
    const live = liveOpLane(l.sessionId)
    if (live) live.title = name
    markChanged(c, 'name')
    return { text: `Renamed lane to ${name}.`, before: { ref: l.ref, name: l.title } }
  }),
  'lane.pin': op<{ on: boolean }>(async ({ on }, c) => {
    const path = lanePath(c)
    const store = await import('../store')
    const pins = new Set(store.getPrefs().pinnedSessions)
    const previous = pins.has(path)
    if (on) pins.add(path)
    else pins.delete(path)
    store.setPinnedSessions([...pins])
    markChanged(c, 'pinned')
    return {
      text: on ? 'Pinned lane.' : 'Unpinned lane.',
      before: { ref: targetLane(c).ref, on: previous },
    }
  }),
  'lane.marker': op<{ marker: string }>(async ({ marker }, c) => {
    const path = lanePath(c)
    const store = await import('../store')
    const markers = store.getPrefs().laneMarkers
    store.setLaneMarkers({ ...markers, [path]: marker })
    markChanged(c, 'marker')
    return {
      text: 'Updated lane marker.',
      before: markers[path] ? { ref: targetLane(c).ref, marker: markers[path] } : undefined,
    }
  }),
}
