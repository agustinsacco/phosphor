import {
  laneControlPolicy,
  runLaneAction,
  laneActionErrorText,
} from '@/platform/serviceLaneControl'
import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { useChatStore } from '@/stores/chat'
import { remoteControlHint } from '@/features/sessions/remoteLaneActions'
import {
  canControlSession,
  machineLabel,
  REMOTE_NOT_READY,
  useSessionHostLane,
} from '@/stores/remoteLanes'
import type { SessionHostLane } from '@/stores/hostLaneOf'
import { hostPhaseLabel, hostReady, startingMachine } from '@/stores/hostReadiness'
import { useHostPhase } from '@/stores/machineStartLimit'

/** pi writes nothing to resume until a first message; the Host refuses Stop before then. */
export const STOP_NEEDS_PROMPT = 'Send a first message before stopping this lane.'

export type LaneControlChannel =
  'hosts:takeControl' | 'hosts:stopLane' | 'hosts:resumeLane' | 'hosts:releaseControl'

export interface LaneControl {
  hostId: string
  /** The Host is connected and has started its lanes (`hostReady`). */
  ready: boolean
  /** The header word for its phase (`hostPhaseLabel`): "Connected", "Starting", "Reconnecting" or "Down". */
  connection: string
  /** "Controlled by you", "No controller", "Starting <machine>…" or the not-connected notice. */
  status: string
  /** Who holds the lane; undefined until the Host lists it. */
  controller: HostLaneView['control']['controller'] | undefined
  /** The Host is ready and offers control at all. */
  enabled: boolean
  /** This device is the lane's controller. */
  transfer: boolean
  controlling: boolean
  /** Why this window may not act on the lane now (`laneControlHint`), or undefined. */
  hint: string | undefined
  /** What the Host says the lane is doing; undefined until the Host lists it. */
  activity: HostLaneView['activity'] | undefined
  /** The lane's process is down, so its lifecycle action is Resume. */
  stopped: boolean
  /** Why Stop is refused right now, if it is. */
  stopBlocked: string | null
  busy: boolean
  error: string | null
  /** Resolves true once the Host confirmed the action. */
  act: (channel: LaneControlChannel) => Promise<boolean>
}

/** Why this window may not act on a Host lane now (`remoteControlHint`), or undefined. */
export function laneControlHint({ host, lane }: SessionHostLane): string | undefined {
  return remoteControlHint(
    hostReady(host),
    !!host?.capabilities.includes('sessions.control'),
    laneControlPolicy(host?.local, lane).actionable,
  )
}

/**
 * Controller state and actions for one remote lane, shared by every surface that
 * offers them (the Desktop control row, the phone lane menu, the read-only bar).
 * Null for a local session or one not yet bound to a Host lane.
 */
export function useLaneControl(sessionId: string | undefined): LaneControl | null {
  const remote = useSessionHostLane(sessionId)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const prompted = useChatStore((s) =>
    sessionId
      ? (s.sessions[sessionId]?.items.some((item) => item.kind === 'user') ?? false)
      : false,
  )
  const phase = useHostPhase(remote?.hostId)
  if (!sessionId || !remote?.laneId) return null
  const { hostId, laneId, host, lane } = remote
  const controller = lane?.control.controller
  const stopped = lane?.activity === 'stopped' || lane?.activity === 'failed'
  async function act(channel: LaneControlChannel): Promise<boolean> {
    setBusy(true)
    try {
      await runLaneAction(channel, hostId, laneId)
      setError(null)
      return true
    } catch (error) {
      setError(laneActionErrorText(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  const ready = hostReady(host)
  const enabled = ready && !!host?.capabilities.includes('sessions.control')
  const controlling = canControlSession(sessionId)
  return {
    hostId,
    ready,
    connection: hostPhaseLabel(phase, host?.state),
    status:
      phase === 'starting'
        ? startingMachine(machineLabel(hostId))
        : !ready
          ? REMOTE_NOT_READY
          : controller
            ? `Controlled by ${controller.self ? 'you' : controller.label}${controller.connected ? '' : ' (disconnected)'}`
            : 'No controller',
    controller,
    enabled,
    controlling,
    transfer: laneControlPolicy(host?.local, lane).transfer,
    hint: laneControlHint(remote),
    activity: lane?.activity,
    stopped,
    stopBlocked: !prompted && !stopped ? STOP_NEEDS_PROMPT : null,
    busy,
    error,
    act,
  }
}
