import { useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import { localMachineLabel } from '@/lib/localMachine'
import { useRemoteLanesStore, machineLabel } from '@/stores/remoteLanes'
import { hostPhaseLabel } from '@/stores/hostReadiness'
import { useHostPhase } from '@/stores/machineStartLimit'
import { Button, Chip } from '@/components/form'
import { useLaneControl } from './useLaneControl'

export { STOP_NEEDS_PROMPT } from './useLaneControl'

/** Where a session runs: "Studio · Connected" for a Host lane, This Mac's name otherwise. */
export function MachineChip({ sessionId }: { sessionId: string }): React.JSX.Element {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  return <HostMachineChip hostId={target?.kind === 'remote' ? target.hostId : undefined} />
}

/** A Host's name and phase (`hostPhase`), as its composer reads it; This Mac's name without a Host. */
export function HostMachineChip({ hostId }: { hostId: string | undefined }): React.JSX.Element {
  const state = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId]?.state : undefined))
  const phase = useHostPhase(hostId)
  useMachinesStore((s) => s.machines)
  return (
    <Chip
      className="bg-chip text-text-secondary shrink-0 whitespace-nowrap"
      data-testid="machine-chip"
    >
      {hostId ? `${machineLabel(hostId)} · ${hostPhaseLabel(phase, state)}` : localMachineLabel()}
    </Chip>
  )
}

export function RemoteLaneControls({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const control = useLaneControl(sessionId)
  if (!control) return null
  // Control cannot change hands until the Host is back; the composer says what it waits for.
  // A reader's holder and Take control are in its locked composer (LaneLock), as on a phone.
  if (!control.ready || !control.controlling)
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
      {control.transfer && (
        <Button size="xs" disabled={busy} onClick={() => void act('hosts:releaseControl')}>
          Release control
        </Button>
      )}
      {/* A crashed lane's Resume is the crash banner's, so there is one to press. */}
      {control.activity !== 'failed' && (
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
