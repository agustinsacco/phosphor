import { create } from 'zustand'
import type { RpcSessionState, SessionStats } from '@shared/rpc'
import { clearLiveStats } from '@/lib/liveStats'
import { useChatStore } from './chat'
import { hostLaneOf, laneWithoutPi } from './hostLaneOf'
import { useRemoteLanesStore } from './remoteLanes'
import { bootstrapSession, useSessionsStore } from './sessions'

/**
 * A Host lane's pi state in the chat store outlives the pi that reported it:
 * stopping the lane leaves its last `meta` and `stats` in place, a read while
 * stopped answers with the last process's state, and a resume shows the lane
 * running before the new pi's replies land. So each Host lane session has a
 * generation, its pi run as this client sees it, which moves whenever the lane
 * stops or starts. A meta or stats write is stamped with the generation it
 * landed in, and counts only while the lane runs and its stamp is the current
 * generation. A start re-reads the lane (`bootstrapSession`), so a reply that
 * landed before the start was seen is read again; the Host client serves a
 * resumed lane only its current run's state. A stop resets the usage overlay's
 * baseline, so a message after the resume adds to no earlier measurement.
 * A session on This Mac's in-app runtime has no Host lane: always live.
 */
interface LaneRun {
  readonly running: boolean
  readonly generation: number
  readonly metaGeneration: number
  readonly statsGeneration: number
}

const useRuns = create<Readonly<Record<string, LaneRun>>>(() => ({}))
/** The meta and stats objects each session's stamps were taken for. */
const seen = new Map<string, { meta: unknown; stats: unknown }>()

function observe(): void {
  const hosts = useRemoteLanesStore.getState().hosts
  const chats = useChatStore.getState().sessions
  const runs = useRuns.getState()
  const next: Record<string, LaneRun> = {}
  const started: string[] = []
  for (const [sessionId, entry] of Object.entries(useSessionsStore.getState().live)) {
    const host = entry.target?.kind === 'remote' ? hosts[entry.target.hostId] : undefined
    const remote = hostLaneOf(entry, host)
    if (!remote) continue
    const running = !laneWithoutPi(remote.lane)
    const before = runs[sessionId]
    let run = before ?? { running, generation: 0, metaGeneration: 0, statsGeneration: 0 }
    if (before && before.running !== running) {
      run = { ...run, running, generation: run.generation + 1 }
      if (running) started.push(sessionId)
      else clearLiveStats(sessionId)
    }
    const { meta = null, stats = null } = chats[sessionId] ?? {}
    const was = seen.get(sessionId)
    if (was && was.meta !== meta) run = { ...run, metaGeneration: run.generation }
    if (was && was.stats !== stats) run = { ...run, statsGeneration: run.generation }
    seen.set(sessionId, { meta, stats })
    if (run !== before) next[sessionId] = run
  }
  if (Object.keys(next).length) useRuns.setState(next)
  for (const sessionId of started) void bootstrapSession(sessionId).catch(() => false)
}

// From load on, ahead of any component's subscription, so a render never sees
// a store change these stamps have not taken in yet.
observe()
useRemoteLanesStore.subscribe(observe)
useSessionsStore.subscribe(observe)
useChatStore.subscribe(observe)

function useCurrent<T>(sessionId: string, value: T | null, stamp: keyof LaneRun): T | null {
  const remote = useSessionsStore((s) => s.live[sessionId]?.target?.kind === 'remote')
  const live = useRuns((s) => {
    const run = s[sessionId]
    return !!run && run.running && run[stamp] === run.generation
  })
  if (!remote) return value
  return live ? value : null
}

/** The session's pi state, once its lane's current pi run reported it; else null. */
export function useLiveMeta(sessionId: string): RpcSessionState | null {
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta ?? null)
  return useCurrent(sessionId, meta, 'metaGeneration')
}

/** The session's usage, once its lane's current pi run measured it; else null. */
export function useLiveStats(sessionId: string): SessionStats | null {
  const stats = useChatStore((s) => s.sessions[sessionId]?.stats ?? null)
  return useCurrent(sessionId, stats, 'statsGeneration')
}
