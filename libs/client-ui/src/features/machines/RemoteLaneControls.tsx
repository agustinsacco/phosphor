import { useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import { localMachineLabel } from '@/lib/localMachine'
import { useRemoteLanesStore, machineLabel, connectionLabel } from '@/stores/remoteLanes'
import { Button, Chip } from '@/components/form'
import { useLaneControl } from './useLaneControl'

export { STOP_NEEDS_PROMPT } from './useLaneControl'

export function MachineChip({ sessionId }: { sessionId: string }): React.JSX.Element {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  useMachinesStore((s) => s.machines)
  return (
    <Chip className="bg-chip text-text-secondary">
      {target?.kind === 'remote'
        ? `${machineLabel(target.hostId)} · ${connectionLabel(hosts[target.hostId]?.state)}`
        : localMachineLabel()}
    </Chip>
  )
}

export function RemoteLaneControls({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const control = useLaneControl(sessionId)
  if (!control) return null
  // Control cannot change hands until the Host is back; the composer says what it waits for.
  if (control.hostState !== 'ready')
    return (
      <div className="px-6 py-2">
        <MachineChip sessionId={sessionId} />
      </div>
    )
  const { act, busy, stopped, stopBlocked } = control
  return (
    <div className="text-text-secondary flex flex-wrap items-center gap-2 px-6 py-2 text-sm">
      <MachineChip sessionId={sessionId} />
      <span>{control.status}</span>
      {control.transfer && !control.controlling && (
        <Button
          size="xs"
          disabled={!control.enabled || busy}
          onClick={() => void act('hosts:takeControl')}
        >
          Take control
        </Button>
      )}
      {control.transfer && control.controlling && (
        <Button size="xs" disabled={busy} onClick={() => void act('hosts:releaseControl')}>
          Release control
        </Button>
      )}
      {/* A crashed lane's Resume is the crash banner's, so there is one to press. */}
      {control.controlling && control.activity !== 'failed' && (
        <Button
          size="xs"
          disabled={busy || stopBlocked !== null}
          title={stopBlocked ?? undefined}
          onClick={() => void act(stopped ? 'hosts:resumeLane' : 'hosts:stopLane')}
        >
          {stopped ? 'Resume' : 'Stop'}
        </Button>
      )}
      {control.error && <span role="alert">{control.error}</span>}
    </div>
  )
}

/**
 * Stands in for the composer on a phone when this device is not the controller,
 * so the one action that unlocks typing sits where typing happens. Who controls
 * the lane is in the lane header, not repeated here.
 */
export function ReadOnlyLaneBar({ sessionId }: { sessionId: string }): React.JSX.Element {
  const control = useLaneControl(sessionId)
  return (
    <div className="compact-observer">
      <p role="status">
        {control && !control.transfer ? 'Read-only.' : 'Read-only. Take control to send messages.'}
      </p>
      {control?.transfer && (
        <Button
          variant="primary"
          disabled={!control.enabled || control.busy}
          onClick={() => void control.act('hosts:takeControl')}
        >
          Take control
        </Button>
      )}
      {control?.error && <p role="alert">{control.error}</p>}
    </div>
  )
}
