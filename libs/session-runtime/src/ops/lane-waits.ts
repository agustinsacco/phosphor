import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { LANE_WAIT_CONNECTIONS } from '@phosphor/shared/ops'
import { authenticatedLane, principalKey } from './principals'
import type { OpPrincipal } from './types'

type Busy = Extract<OpsRunResult, { status: 'denied' }>
const busy = (text: string): Busy => ({ status: 'denied', code: 'busy', text })

/** A long read owns no control-queue slot. Cap active reads independently of ordinary op rate limits. */
export function createLaneWaits() {
  const byOrigin = new Map<string, Set<string>>()
  return {
    take(principal: OpPrincipal, signal: AbortSignal): Busy | (() => void) {
      const origin = principalKey(principal)
      const lane = authenticatedLane(principal) ?? origin
      const active = byOrigin.get(origin) ?? new Set<string>()
      if (active.has(lane)) return busy('This caller already has an active lane wait.')
      if (active.size >= LANE_WAIT_CONNECTIONS)
        return busy(`This machine already has ${LANE_WAIT_CONNECTIONS} active lane waits.`)
      active.add(lane)
      byOrigin.set(origin, active)
      let taken = true
      const release = () => {
        if (!taken) return
        taken = false
        signal.removeEventListener('abort', release)
        active.delete(lane)
        if (!active.size) byOrigin.delete(origin)
      }
      signal.addEventListener('abort', release, { once: true })
      return release
    },
  }
}
