import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type {
  LaneDeferred,
  OpHandlerContext,
  OpsBinding,
} from '@phosphor/session-runtime/ops/types'
import type { RpcCommand } from '@shared/rpc'
import { deferredRpcCommand } from '@phosphor/session-runtime/ops/deferred-rpc'
import { broadcast } from '../broadcast'
import { lanePath, liveOpLane, liveOpRef, targetLane } from './lanes'
import { op } from '@phosphor/session-runtime/ops/results'
import { laneControlHandlers } from '@phosphor/session-runtime/ops/lane-controls'

async function command(id: string, rpc: RpcCommand) {
  const { desktopSessions } = await import('../pi/session-runtime')
  const result = await desktopSessions.command(id, rpc)
  if (!result.success)
    throw new OpRefusal('unavailable', result.error ?? 'pi refused this command.')
}
function deferredCommand(item: LaneDeferred): RpcCommand {
  const rpc = deferredRpcCommand(item)
  if (!rpc) throw new Error('This Mac cannot apply that deferred operation.')
  return rpc
}
export const deferred: OpsBinding['deferred'] = {
  async apply(id, items) {
    for (const item of items) {
      await command(id, deferredCommand(item))
      const laneRef = liveOpRef(id)
      if (laneRef)
        broadcast('ops:changed', {
          machine: 'local',
          kind: 'lane',
          laneRef,
          fields: [item.kind],
        })
    }
    return { ok: true }
  },
}
export const controlHandlers = laneControlHandlers(targetLane)
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
