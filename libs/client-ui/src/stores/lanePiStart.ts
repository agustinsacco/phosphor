import type { HostsSnapshot } from '@shared/ipc'
import { useChatStore } from './chat'
import { hostLaneOf, laneWithoutPi } from './hostLaneOf'
import { bootstrapSession, sessionIsOpen, useSessionsStore } from './sessions'

/** Re-reads in flight, by session; `again` asks for one more after it, never a second at once. */
const rereading = new Map<string, { again: boolean }>()

/** pi runs but this client lacks its state or models: a read failed or predated its start. */
function incomplete(sessionId: string): boolean {
  const chat = useChatStore.getState().sessions[sessionId]
  return !!chat && (!chat.meta || chat.modelsFailed)
}

/**
 * A Host lane adopted without a pi has no state or models: the Host refuses
 * both until its pi runs. The snapshot shows that pi come up, whatever started
 * it (This Mac's warm on open, a first prompt's resume, Resume from the lane
 * menu), so each adopted lane that leaves `stopped`/`failed` reads them again
 * as bootstrap does. Reads the Host's outage cut short are retried when it is
 * ready again, since a reconnect need not replay the start. The transcript is
 * not read again.
 */
export function rereadLanesWhosePiStarted(hosts: HostsSnapshot, previous: HostsSnapshot): void {
  if (hosts === previous) return
  for (const entry of Object.values(useSessionsStore.getState().live)) {
    if (entry.target?.kind !== 'remote') continue
    const host = hosts[entry.target.hostId]
    const was = previous[entry.target.hostId]
    const now = hostLaneOf(entry, host)?.lane
    if (!now || laneWithoutPi(now) || host?.state !== 'ready') continue
    const before = hostLaneOf(entry, was)?.lane
    const started = !!before && laneWithoutPi(before)
    // A Host listed for the first time is not back; its lanes' adoption reads them.
    const back = !!was && (was.state !== 'ready' || was.connectionToken !== host.connectionToken)
    if (started || (back && incomplete(entry.phosphorId))) reread(entry.phosphorId)
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
  // Joining a read in flight (adoption, a stream reset) reads once more if it left the lane incomplete.
  void bootstrapSession(sessionId)
    // Bootstrap degrades per read; a failed one leaves the recorded chips as they were.
    .catch(() => false)
    .finally(() => {
      rereading.delete(sessionId)
      if (run.again && sessionIsOpen(sessionId)) reread(sessionId)
    })
}
