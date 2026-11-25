import { useEffect } from 'react'
import { create } from 'zustand'
import type { RpcSessionState, SessionStats } from '@shared/rpc'
import { useChatStore } from './chat'
import { hostLaneOf, laneWithoutPi } from './hostLaneOf'
import { useRemoteLanesStore, useSessionHostLane } from './remoteLanes'
import { useSessionsStore } from './sessions'

/**
 * A Host lane's pi state in the chat store outlives the pi that reported it:
 * stopping the lane leaves its last `meta` and `stats` in place, and a resume
 * shows the lane running before the new pi's `get_state` and
 * `get_session_stats` replies land (or when one fails). These hooks answer the
 * chat store's meta and stats only once they come from the lane's current pi:
 * never while the lane runs no pi, and after a resume only once the value is a
 * new one, not the one it held when the lane stopped. Every reply is a fresh
 * object, so identity tells them apart. A session on This Mac's in-app runtime
 * has no Host lane and always reads its live state.
 */
interface Leftover {
  readonly meta: RpcSessionState | null
  readonly stats: SessionStats | null
}

const useLeftovers = create<Readonly<Record<string, Leftover>>>(() => ({}))
/** Whether each Host lane session's lane ran no pi when last looked at. */
const withoutPi = new Map<string, boolean>()

/** Takes each Host lane session's chat state as it was when its lane stopped. */
function observe(): void {
  const hosts = useRemoteLanesStore.getState().hosts
  const chats = useChatStore.getState().sessions
  const stopped: Record<string, Leftover> = {}
  for (const [sessionId, entry] of Object.entries(useSessionsStore.getState().live)) {
    const host = entry.target?.kind === 'remote' ? hosts[entry.target.hostId] : undefined
    const remote = hostLaneOf(entry, host)
    if (!remote) continue
    const now = laneWithoutPi(remote.lane)
    if (now && !withoutPi.get(sessionId))
      stopped[sessionId] = {
        meta: chats[sessionId]?.meta ?? null,
        stats: chats[sessionId]?.stats ?? null,
      }
    withoutPi.set(sessionId, now)
  }
  if (Object.keys(stopped).length) useLeftovers.setState(stopped)
}

let watching = false
/** Watches lanes from the first composer on, also while no composer is open. */
function watchLanes(): void {
  if (watching) return
  watching = true
  observe()
  useRemoteLanesStore.subscribe(observe)
  useSessionsStore.subscribe(observe)
}

function useCurrent<T>(sessionId: string, value: T | null, leftover: (l: Leftover) => T | null) {
  useEffect(watchLanes, [])
  const hostLane = useSessionHostLane(sessionId)
  const left = useLeftovers((s) => s[sessionId])
  if (!hostLane) return value
  if (laneWithoutPi(hostLane.lane) || (left && leftover(left) === value)) return null
  return value
}

/** The session's pi state, once it comes from the lane's current pi; else null. */
export function useLiveMeta(sessionId: string): RpcSessionState | null {
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta ?? null)
  return useCurrent(sessionId, meta, (l) => l.meta)
}

/** The session's usage, once it comes from the lane's current pi; else null. */
export function useLiveStats(sessionId: string): SessionStats | null {
  const stats = useChatStore((s) => s.sessions[sessionId]?.stats ?? null)
  return useCurrent(sessionId, stats, (l) => l.stats)
}
