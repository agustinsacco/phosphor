import { TAKE_CONTROL_FIRST } from '@/features/sessions/remoteLaneActions'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { canControlSession, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'

/**
 * Why this client cannot write into a lane's workspace now, or undefined when it can. This Mac's
 * lanes always can; a Host lane needs file editing, lane control and this client holding the lane,
 * which is what the Host checks on every write.
 */
export function laneWriteRefusal(sessionId: string): string | undefined {
  const target = useSessionsStore.getState().live[sessionId]?.target
  if (target?.kind !== 'remote') return undefined
  const host = useRemoteLanesStore.getState().hosts[target.hostId]
  return (
    hostFeatureRefusal(host, 'workspaces.write') ??
    hostFeatureRefusal(host, 'sessions.control') ??
    (canControlSession(sessionId) ? undefined : TAKE_CONTROL_FIRST)
  )
}

/** laneWriteRefusal for a component, re-rendering when the lane, its Host or its controller moves. */
export function useLaneWriteRefusal(sessionId: string): string | undefined {
  useSessionsStore((s) => s.live[sessionId]?.target)
  useSessionsStore((s) => s.live[sessionId]?.laneId)
  return useRemoteLanesStore(() => laneWriteRefusal(sessionId))
}
