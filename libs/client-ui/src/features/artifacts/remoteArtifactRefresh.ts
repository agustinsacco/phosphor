import { useSessionsStore } from '@/stores/sessions'
import type { HostConnectionView } from '@shared/ipc'
import { useArtifactsStore } from '@/stores/artifacts'

// One read at a time per handle. A notification during a read queues one more
// read: the first reply may predate the tool result that triggered it.
// remoteLanes registers its host view here. Importing that store from this module
// would put remoteLanes (and machines) on sessions' import cycle.
let hostView: (hostId: string) => HostConnectionView | undefined = () => undefined
export function bindRemoteHostView(read: typeof hostView): void {
  hostView = read
}

const pending = new Map<string, { dirty: boolean; promise: Promise<boolean> }>()
let generation = 0
export function invalidateRemoteArtifactReads(): void {
  generation++
  for (const job of pending.values()) job.dirty = false
}

function readKey(sessionId: string): string | undefined {
  const state = useSessionsStore.getState()
  const entry = state.live[sessionId]
  if (entry?.target?.kind !== 'remote') return
  const host = hostView(entry.target.hostId)
  if (host?.state !== 'ready' || !host.capabilities.includes('artifacts.read')) return
  return JSON.stringify([
    generation,
    state.activeSessionId,
    entry.target.hostId,
    entry.laneId,
    host.connectionToken,
    host.cursor?.epoch,
  ])
}

export function refreshRemoteArtifacts(sessionId: string): Promise<boolean> {
  const existing = pending.get(sessionId)
  if (existing) {
    existing.dirty = true
    return existing.promise
  }
  const job = { dirty: true, promise: Promise.resolve(false) }
  pending.set(sessionId, job)
  job.promise = (async () => {
    let applied = false
    while (job.dirty) {
      job.dirty = false
      applied = false
      const key = readKey(sessionId)
      if (!key) continue
      try {
        const snapshots = await window.phosphor.invoke('artifacts:forSession', sessionId)
        if (readKey(sessionId) === key) {
          useArtifactsStore.getState().hydrate(sessionId, snapshots)
          applied = true
        }
      } catch {
        // A disconnected Host is not an authoritative empty result.
      }
    }
    return applied
  })().finally(() => pending.delete(sessionId))
  return job.promise
}
