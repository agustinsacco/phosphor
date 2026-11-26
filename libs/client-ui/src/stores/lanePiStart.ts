import type { HostsSnapshot } from '@shared/ipc'
import { hostLaneOf, laneWithoutPi } from './hostLaneOf'
import { bootstrapSession, sessionIsOpen, useSessionsStore } from './sessions'

/** Re-reads in flight, by session; `again` asks for one more after it, never a second at once. */
const rereading = new Map<string, { again: boolean }>()

/**
 * A Host lane adopted without a pi has no state or models: the Host refuses
 * both until its pi runs. The snapshot shows that pi come up, whatever started
 * it (This Mac's warm on open, a first prompt's resume, Resume from the lane
 * menu), so each adopted lane that leaves `stopped`/`failed` reads them again
 * as bootstrap does. Its transcript is not read again.
 */
export function rereadLanesWhosePiStarted(hosts: HostsSnapshot, previous: HostsSnapshot): void {
  if (hosts === previous) return
  for (const entry of Object.values(useSessionsStore.getState().live)) {
    if (entry.target?.kind !== 'remote') continue
    const before = hostLaneOf(entry, previous[entry.target.hostId])?.lane
    const now = hostLaneOf(entry, hosts[entry.target.hostId])?.lane
    if (before && now && laneWithoutPi(before) && !laneWithoutPi(now)) reread(entry.phosphorId)
  }
}

function reread(sessionId: string): void {
  const pending = rereading.get(sessionId)
  if (pending) {
    pending.again = true
    return
  }
  const run = { again: false }
  rereading.set(sessionId, run)
  void bootstrapSession(sessionId)
    // Bootstrap degrades per read; a failed one leaves the recorded chips as they were.
    .catch(() => false)
    .finally(() => {
      rereading.delete(sessionId)
      if (run.again && sessionIsOpen(sessionId)) reread(sessionId)
    })
}
