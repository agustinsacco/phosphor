import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { AppServices } from '../../session/app-services'

const unavailable = () => ({
  text: 'Brain is unavailable right now.',
  data: { status: 'unavailable' },
})

/** Neither a surface nor a claimed actor/lane can borrow a live lane's Brain refs. */
export function createBrainHandlers(appServices: AppServices | null | undefined) {
  const handle =
    (method: 'search' | 'flag'): OpHandler =>
    async (args, { principal, lane }) => {
      if (
        principal.kind !== 'agent' ||
        principal.laneRef !== lane?.ref ||
        lane.sessionId !== principal.sessionId
      )
        throw new OpRefusal('bad-request', 'Brain recall needs the asking lane.')
      const port = appServices?.forLane(principal.sessionId, lane.title)
      if (!port) return unavailable()
      try {
        return await port[method](args as Record<string, unknown>)
      } catch {
        return unavailable()
      }
    }
  return { 'brain.search': handle('search'), 'brain.flag': handle('flag') }
}
