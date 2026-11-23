import { useSessionsStore } from '@/stores/sessions'
import type { HostConnectionView } from '@shared/ipc'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useArtifactsStore } from '@/stores/artifacts'
import { isArtifactWriteTool } from '@/lib/artifactTools'
import type { SessionPush } from '@shared/models'

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
  if (!host || hostFeatureRefusal(host, 'artifacts.read')) return
  return JSON.stringify([
    generation,
    state.activeSessionId,
    entry.target.hostId,
    entry.laneId,
    host.connectionToken,
    host.cursor?.epoch,
  ])
}

/** Sessions that wrote an artifact in the turn now running. */
const wroteThisTurn = new Set<string>()

/**
 * The pushes after which a Host lane's artifacts may have changed. pi emits
 * `tool_execution_end` before it appends the tool's result, and a parallel batch
 * or a codemode script appends only once every sibling is done, so the read at
 * tool end can come back without the artifact. `turn_end` follows every append
 * (and `artifacts.ts` saving a script's writes), so a turn that wrote reads once
 * more then. A local session has no read key, so this is a no-op for it.
 */
export function refreshArtifactsAfter(sessionId: string, push: SessionPush): void {
  if (push.kind === 'resync') return void refreshRemoteArtifacts(sessionId)
  if (push.kind === 'exit') wroteThisTurn.delete(sessionId)
  if (push.kind !== 'event') return
  const { event } = push
  if (event.type === 'tool_execution_end' && isArtifactWriteTool(event.toolName)) {
    wroteThisTurn.add(sessionId)
    void refreshRemoteArtifacts(sessionId)
  } else if (
    (event.type === 'turn_end' || event.type === 'agent_end') &&
    wroteThisTurn.delete(sessionId)
  )
    void refreshRemoteArtifacts(sessionId)
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
    try {
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
    } finally {
      // In the same tick as the last dirty check, never a later one: a refresh
      // asked for in between would mark a finished read dirty and be lost.
      pending.delete(sessionId)
    }
    return applied
  })()
  return job.promise
}
