import { normalizeLabel } from '@phosphor/shared/control-api'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op } from '@phosphor/session-runtime/ops/results'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { LaneEditRefused, writeStoppedLaneName } from '../../lanes/editing'
import type { StoredLane } from '../../lanes/store'
import type { SessionOwner } from '../../session/session-owner'
import { hasCaps } from '../binding'
import type { DaemonHandlerDeps } from './index'
import { requireRuntime, targetLane } from './lane-target'

function checkControl(ctx: OpHandlerContext, lane: StoredLane, fence?: number): void {
  ctx.signal.throwIfAborted()
  const { principal } = ctx
  if (principal.kind === 'surface') {
    if (
      !hasCaps(principal) ||
      !(principal.currentCaps?.() ?? principal.caps).includes('sessions.control')
    )
      throw new OpRefusal('forbidden', 'This connection cannot control lanes.')
    // A fence pins the control the client saw. Undo carries none: the user only has to hold it now.
    const controller = lane.control.controller?.clientId
    if (
      fence !== undefined
        ? controller !== principal.clientId || lane.control.fence !== fence
        : controller !== undefined && controller !== principal.clientId
    )
      throw new OpRefusal('not-controller', 'Lane control changed. Take control first.')
  } else if (lane.control.fence !== ctx.lane?.controlFence) {
    throw new OpRefusal('not-controller', 'Lane control changed. Try again.')
  }
}

export function laneRename(deps: DaemonHandlerDeps) {
  return op<{ name: string; controlFence?: number }>(async (args, ctx) => {
    const name = /[\r\n\u2028\u2029]/.test(args.name) ? null : normalizeLabel(args.name)
    if (!name) throw new OpRefusal('bad-request', 'Use a name of 1–80 characters on one line.')
    const { laneId, ref } = targetLane(ctx)
    const stored = () => {
      const lane = deps.store.getLane(laneId)
      if (lane?.removedAt !== null)
        throw new OpRefusal('unavailable', 'That lane is unavailable on this machine.')
      return lane
    }
    const file = stored().sessionFile
    const current = () => {
      const lane = stored()
      if (lane.sessionFile !== file)
        throw new OpRefusal('unavailable', 'The lane’s saved conversation changed. Try again.')
      checkControl(ctx, lane, args.controlFence)
      return lane
    }
    // After pi or the file took the name: control was checked before that write, so
    // only a removed lane stops the title from following it.
    const named = () => {
      stored()
      deps.store.updateLane(laneId, { title: name })
      requireRuntime(deps.laneRuntime).publishSummary(laneId)
    }
    const rename = async (owner?: () => SessionOwner | undefined) => {
      const lane = current()
      // Resume spawns pi, then attaches it after the path lock: a starting pi owns the
      // file before the lane names it. It takes the name when ready, as an attached one does.
      const holder = deps.daemonLanes.sessionFor(laneId) ? undefined : owner?.()
      if (holder?.stopping) throw new OpRefusal('busy', 'The lane is stopping. Try again.')
      const sessionId = deps.daemonLanes.sessionFor(laneId) ?? holder?.sessionId
      if (sessionId) {
        const result = await requireRuntime(deps.laneRuntime).command(sessionId, {
          type: 'set_session_name',
          name,
        })
        if (!result.success)
          throw new OpRefusal('unavailable', result.error ?? 'pi refused this command.')
        // An attached lane records the name from pi's answer. A starting one is not yet
        // bound to the lane, so store and publish it here, as the stopped path does.
        if (holder) named()
      } else {
        if (!file) throw new OpRefusal('unavailable', 'This lane has no saved conversation yet.')
        try {
          await writeStoppedLaneName(file, name, current)
        } catch (error) {
          if (error instanceof LaneEditRefused) throw new OpRefusal('unavailable', error.message)
          throw error
        }
        named()
      }
      return {
        text: `Renamed lane to ${name}.`,
        before: { ref, name: lane.title ?? '' },
      }
    }
    return file ? deps.editing.runtime.withSessionFile(file, rename) : rename()
  })
}
