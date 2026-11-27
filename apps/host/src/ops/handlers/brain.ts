import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpHandler, OpHandlerResult } from '@phosphor/session-runtime/ops/types'
import type { HostLaneRecall } from '../../brain/lane-recall'
import type { AppServices } from '../../session/app-services'

const unavailable = () => ({
  text: 'Brain is unavailable right now.',
  data: { status: 'unavailable' },
})

/**
 * Neither a surface nor a claimed actor/lane can borrow a live lane's Brain refs. The Host's own
 * Brain answers while it is active; otherwise a Desktop registration may (the transitional bridge).
 */
export function createBrainHandlers(
  appServices: AppServices | null | undefined,
  native?: HostLaneRecall | null,
) {
  const handle =
    (method: 'search' | 'flag'): OpHandler =>
    async (args, { principal, lane }) => {
      if (
        principal.kind !== 'agent' ||
        principal.laneRef !== lane?.ref ||
        lane.sessionId !== principal.sessionId
      )
        throw new OpRefusal('bad-request', 'Brain recall needs the asking lane.')
      try {
        const port = native?.active()
          ? await native.forLane(principal.sessionId, lane.title)
          : appServices?.forLane(principal.sessionId, lane.title)
        if (!port) return unavailable()
        // Both ports return a lane-scoped `{ text, data }` projection, never the raw result.
        return (await port[method](args as Record<string, unknown>)) as OpHandlerResult
      } catch {
        return unavailable()
      }
    }
  return { 'brain.search': handle('search'), 'brain.flag': handle('flag') }
}
