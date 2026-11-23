import type { HostLaneView } from '@shared/ipc'
import type { SessionDebugSource } from '@/lib/sessionDebugInfo'
import { piCall, piCallOk } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { machineLabel } from '@/stores/remoteLanes'
import { makeRoutine } from '@/stores/routines'

/**
 * Markers other lanes on this Host chose, in any folder, for the picker to dim:
 * This Mac dims every lane's choice on the machine too. Explicit choices only,
 * as on This Mac: derived markers collide by design.
 */
export function usedMarkers(lanes: readonly HostLaneView[], lane: HostLaneView): Set<string> {
  return new Set(
    lanes.flatMap((other) => (other.laneId !== lane.laneId && other.marker ? [other.marker] : [])),
  )
}

export async function renameLane(sessionId: string, name: string): Promise<void> {
  if (!(await piCallOk(sessionId, { type: 'set_session_name', name }))) throw new Error()
  useChatStore.getState().patchMeta(sessionId, { sessionName: name })
}

/**
 * "Make routine…" on a Host lane: This Mac's draft (the lane's own name, blank
 * when it has none, and its first prompt), opened on the lane's Host and
 * folder. The lane's session is open by now, so its transcript holds the first prompt.
 */
export function routineFromLane(hostId: string, lane: HostLaneView, sessionId: string) {
  const chat = useChatStore.getState().sessions[sessionId]
  const first = chat?.items.find((i) => i.kind === 'user')
  const name = chat?.meta?.sessionName?.trim() || lane.title || ''
  makeRoutine('', name, first?.kind === 'user' ? first.text : '', {
    hostId,
    repositoryId: lane.repositoryId,
  })
}

export async function sessionCost(sessionId: string): Promise<number> {
  const stats = await piCall(sessionId, { type: 'get_session_stats' })
  if (!stats) throw new Error()
  return stats.cost
}

/**
 * A Host lane's debug block: pi's id and model from its open session (else the
 * Host summary's model) and where it runs. Never a Host path: the lane's folder
 * and session file stay on the Host.
 */
export function remoteLaneDebugSource(
  hostId: string,
  lane: HostLaneView,
  sessionId: string | undefined,
): SessionDebugSource {
  const meta = sessionId ? useChatStore.getState().sessions[sessionId]?.meta : null
  const model = meta?.model ?? lane.model
  return {
    sessionId: meta?.sessionId,
    provider: model?.provider,
    model: model?.id,
    context: [
      ['machine', machineLabel(hostId)],
      ['host', hostId],
      ['lane', lane.laneId],
      ['branch', lane.branch ?? 'none'],
    ],
  }
}
