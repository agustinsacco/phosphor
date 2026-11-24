import { remoteLaneKey } from '@phosphor/shared/remote-host'
import { useSessionHostLane } from '@/stores/remoteLanes'
import { useChatStore } from '@/stores/chat'
import { usePlatform } from '@/platform/Platform'

/** The renderer handle is not pi's id. Before the first get_state there is
 * no in-app lane ref; never fall back to an unfiltered machine-wide read. */
export function useAgentLaneScope(sessionId: string) {
  const remote = useSessionHostLane(sessionId)
  const piId = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionId)
  const { localLanes } = usePlatform()
  const machine = remote?.hostId ?? 'local'
  const lane = remote
    ? remote.laneId && remote.host?.ops && remote.host.state === 'ready'
      ? remoteLaneKey(remote.host.enrolledHostId ?? remote.hostId, remote.laneId)
      : null
    : localLanes && piId
      ? `local/session:${piId}`
      : null
  return { machine, lane }
}
