import { canControlSession, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'

/**
 * canControlSession for a component: true for This Mac's sessions and for a Host
 * lane this window holds. It re-renders when the session's target or lane moves
 * (sessions store) and when its Host or controller changes (remote lanes store).
 */
export function useCanControlSession(sessionId: string): boolean {
  useSessionsStore((s) => s.live[sessionId]?.target)
  useSessionsStore((s) => s.live[sessionId]?.laneId)
  return useRemoteLanesStore(() => canControlSession(sessionId))
}
