import { useState } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore, canControlSession, machineLabel } from '@/stores/remoteLanes'
import { Button } from '@/components/form'

export function MachineChip({ sessionId }: { sessionId: string }): React.JSX.Element {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  return (
    <span className="text-text-secondary px-2 text-sm">
      {target?.kind === 'remote' ? machineLabel(target.hostId) : 'This Mac'}
    </span>
  )
}

export function RemoteLaneControls({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const entry = useSessionsStore((s) => s.live[sessionId])
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (entry?.target?.kind !== 'remote' || !entry.laneId) return null
  const hostId = entry.target.hostId
  const laneId = entry.laneId
  const host = hosts[hostId]
  const lane = host?.lanes.find((lane) => lane.laneId === laneId)
  const controller = lane?.control.controller
  const enabled = host?.state === 'ready' && host.capabilities.includes('sessions.control')
  async function act(
    channel: 'hosts:takeControl' | 'hosts:stopLane' | 'hosts:resumeLane',
  ): Promise<void> {
    setBusy(true)
    try {
      await window.phosphor.invoke(channel, hostId, laneId)
      setError(null)
    } catch {
      setError('The Host could not confirm this. Check the lane before retrying.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="text-text-secondary flex flex-wrap items-center gap-2 px-6 py-2 text-sm">
      <MachineChip sessionId={sessionId} />
      <span>
        {host?.state !== 'ready'
          ? `${machineLabel(hostId)} is offline`
          : controller
            ? `Controlled by ${controller.self ? 'you' : controller.label}${controller.connected ? '' : ' (disconnected)'}`
            : 'No controller'}
      </span>
      {!canControlSession(sessionId) && (
        <Button size="xs" disabled={!enabled || busy} onClick={() => void act('hosts:takeControl')}>
          Take control
        </Button>
      )}
      {canControlSession(sessionId) && (
        <Button
          size="xs"
          disabled={busy}
          onClick={() =>
            void act(
              lane?.activity === 'stopped' || lane?.activity === 'failed'
                ? 'hosts:resumeLane'
                : 'hosts:stopLane',
            )
          }
        >
          {lane?.activity === 'stopped' || lane?.activity === 'failed' ? 'Resume' : 'Stop'}
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  )
}
