import type { HostsSnapshot } from '@phosphor/shared/ipc'
import { openRemoteLane, useRemoteLanesStore } from '../stores/remoteLanes'

/** How long launch waits for This Mac's service to list the last lane. */
const RESUME_WAIT_MS = 10_000

/**
 * Daemon mode's launch resume: once This Mac's service lists the last lane,
 * open it. A lane that never appears, or a launch that moved on, is skipped
 * quietly; resuming is a convenience, not a request that can fail.
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
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (found: boolean) => {
      if (settled) return
      settled = true
      off()
      clearTimeout(timer)
      if (!found || cancelled()) resolve(false)
      else openRemoteLane(hostId, laneId).then(resolve, () => resolve(false))
    }
    const off = useRemoteLanesStore.subscribe((state) => {
      if (listed(state.hosts)) finish(true)
    })
    const timer = setTimeout(() => finish(false), RESUME_WAIT_MS)
    if (listed(useRemoteLanesStore.getState().hosts)) finish(true)
  })
}
