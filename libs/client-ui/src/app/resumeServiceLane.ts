import type { HostsSnapshot } from '@phosphor/shared/ipc'
import { useLayoutStore } from '../stores/layout'
import { openRemoteLane, useRemoteLanesStore } from '../stores/remoteLanes'
import { useSessionsStore } from '../stores/sessions'

/** How long launch waits for This Mac's service to list the last lane: a loaded Mac can be slow. */
const RESUME_WAIT_MS = 30_000

/**
 * Daemon mode's launch resume: once This Mac's service lists the last lane,
 * open it. A lane that never appears, a launch that moved on, or a page or
 * lane you opened while it waited is skipped quietly; resuming is a
 * convenience, never a request that can fail or take you somewhere.
 */
export function resumeServiceLane(
  hostId: string,
  laneId: string,
  cancelled: () => boolean,
): Promise<boolean> {
  const listed = (hosts: HostsSnapshot) => {
    const host = hosts[hostId]
    return host?.state === 'ready' && host.lanes.some((lane) => lane.laneId === laneId)
  }
  const nav = useSessionsStore.getState().navSeq
  const page = useLayoutStore.getState().page
  const moved = () =>
    useSessionsStore.getState().navSeq !== nav || useLayoutStore.getState().page !== page
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (found: boolean) => {
      if (settled) return
      settled = true
      off()
      clearTimeout(timer)
      if (!found || cancelled() || moved()) resolve(false)
      else openRemoteLane(hostId, laneId).then(resolve, () => resolve(false))
    }
    const off = useRemoteLanesStore.subscribe((state) => {
      if (listed(state.hosts)) finish(true)
    })
    const timer = setTimeout(() => finish(false), RESUME_WAIT_MS)
    if (listed(useRemoteLanesStore.getState().hosts)) finish(true)
  })
}
