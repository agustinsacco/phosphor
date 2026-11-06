import { useState } from 'react'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { useChatStore } from '@/stores/chat'
import { remoteControlHint } from '@/features/sessions/remoteLaneActions'
import {
  canControlSession,
  connectionLabel,
  REMOTE_NOT_READY,
  useSessionHostLane,
} from '@/stores/remoteLanes'
import type { SessionHostLane } from '@/stores/hostLaneOf'

/** pi writes nothing to resume until a first message; the Host refuses Stop before then. */
export const STOP_NEEDS_PROMPT = 'Send a first message before stopping this lane.'

export type LaneControlChannel =
  'hosts:takeControl' | 'hosts:stopLane' | 'hosts:resumeLane' | 'hosts:releaseControl'

export interface LaneControl {
  hostId: string
  hostState: HostConnectionView['state'] | undefined
  /** "Connected", "Reconnecting" or "Down". */
  connection: string
  /** "Controlled by you", "No controller", or the not-connected notice. */
  status: string
  /** The Host is ready and offers control at all. */
  enabled: boolean
  /** This device is the lane's controller. */
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
    host?.state === 'ready',
    !!host?.capabilities.includes('sessions.control'),
    lane?.control.controller?.self === true,
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
  if (!sessionId || !remote?.laneId) return null
  const { hostId, laneId, host, lane } = remote
  const controller = lane?.control.controller
  const stopped = lane?.activity === 'stopped' || lane?.activity === 'failed'
  async function act(channel: LaneControlChannel): Promise<boolean> {
    setBusy(true)
    try {
      await window.phosphor.invoke(channel, hostId, laneId)
      setError(null)
      return true
    } catch {
      setError('The Host could not confirm this. Check the lane before retrying.')
      return false
    } finally {
      setBusy(false)
    }
  }
  const enabled = host?.state === 'ready' && host.capabilities.includes('sessions.control')
  const controlling = canControlSession(sessionId)
  return {
    hostId,
    hostState: host?.state,
    connection: connectionLabel(host?.state),
    status:
      host?.state !== 'ready'
        ? REMOTE_NOT_READY
        : controller
          ? `Controlled by ${controller.self ? 'you' : controller.label}${controller.connected ? '' : ' (disconnected)'}`
          : 'No controller',
    enabled,
    controlling,
    hint: laneControlHint(remote),
    activity: lane?.activity,
    stopped,
    stopBlocked: !prompted && !stopped ? STOP_NEEDS_PROMPT : null,
    busy,
    error,
    act,
  }
}
