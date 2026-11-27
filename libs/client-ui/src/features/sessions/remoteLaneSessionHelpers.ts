import { OpDenied, runAgentOp } from '@/features/agent-control/agentOps'
import { ensureServiceLaneControl, ServiceLaneControlRefused } from '@/platform/serviceLaneControl'
import { refreshHostsSnapshot } from '@/stores/hostsSnapshotRead'
import type { HostLaneView } from '@shared/ipc'
import type { SessionDebugSource } from '@/lib/sessionDebugInfo'
import { markersChosenByOthers } from '@/lib/laneMarker'
import { piCall } from '@/lib/rpc'
import { applySessionRename } from './sessionActions'
import { useChatStore } from '@/stores/chat'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { makeRoutine } from '@/stores/routines'

/**
 * Markers other lanes on this Host chose, in any folder, for the picker to dim:
 * This Mac dims every lane's choice on the machine too. Explicit choices only,
 * as on This Mac: derived markers collide by design.
 */
export function usedMarkers(lanes: readonly HostLaneView[], lane: HostLaneView): Set<string> {
  return markersChosenByOthers(
    lanes.map((other) => [other.laneId, other.marker] as const),
    lane.laneId,
  )
}

/** A running lane's rename through pi; a refusal throws to the lane's dialog runner. */
export async function renameLane(sessionId: string, name: string): Promise<void> {
  if (!(await applySessionRename(sessionId, name))) throw new Error()
}

/** The capable Host chooses the running or stopped path at the time of the edit. */
export async function renameSavedHostLane(
  hostId: string,
  laneId: string,
  name: string,
  /** The lane's open chat, if any: its cached name is what the row and top bar show. */
  sessionId?: string,
): Promise<void> {
  const currentHost = () => useRemoteLanesStore.getState().hosts[hostId]
  if (currentHost()?.local) await ensureServiceLaneControl(hostId, laneId)
  const control = currentHost()?.lanes.find((lane) => lane.laneId === laneId)?.control
  if (!control?.controller?.self) throw new ServiceLaneControlRefused('Take control first.')
  try {
    await runAgentOp(hostId, 'lane.rename', { ref: laneId, name, controlFence: control.fence })
  } catch (error) {
    if (error instanceof OpDenied) throw new ServiceLaneControlRefused(error.message)
    throw error
  }
  if (sessionId) useChatStore.getState().patchMeta(sessionId, { sessionName: name })
  await refreshHostsSnapshot()
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
