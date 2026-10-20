import { useState } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import {
  useRemoteLanesStore,
  canControlSession,
  connectionLabel,
  REMOTE_NOT_READY,
} from '@/stores/remoteLanes'

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
  /** The lane's process is down, so its lifecycle action is Resume. */
  stopped: boolean
  /** Why Stop is refused right now, if it is. */
  stopBlocked: string | null
  busy: boolean
  error: string | null
  /** Resolves true once the Host confirmed the action. */
  act: (channel: LaneControlChannel) => Promise<boolean>
}

/**
 * Controller state and actions for one remote lane, shared by every surface that
 * offers them (the Desktop control row, the phone lane menu, the read-only bar).
 * Null for a local session or one not yet bound to a Host lane.
 */
export function useLaneControl(sessionId: string | undefined): LaneControl | null {
  const entry = useSessionsStore((s) => (sessionId ? s.live[sessionId] : undefined))
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const prompted = useChatStore((s) =>
    sessionId
      ? (s.sessions[sessionId]?.items.some((item) => item.kind === 'user') ?? false)
      : false,
  )
  if (!sessionId || entry?.target?.kind !== 'remote' || !entry.laneId) return null
  const hostId = entry.target.hostId
  const laneId = entry.laneId
  const host = hosts[hostId]
  const lane = host?.lanes.find((item) => item.laneId === laneId)
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
    enabled: host?.state === 'ready' && host.capabilities.includes('sessions.control'),
    controlling: canControlSession(sessionId),
    stopped,
    stopBlocked: !prompted && !stopped ? STOP_NEEDS_PROMPT : null,
    busy,
    error,
    act,
  }
}
