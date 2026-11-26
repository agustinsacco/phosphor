import { useMemo } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { useMachinesStore } from '@/stores/machines'
import {
  useRemoteLanesStore,
  machineLabel,
  connectionLabel,
  hostPending,
} from '@/stores/remoteLanes'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useMachineCaps } from '@/stores/machineCaps'
import { useLaneEditing, visibleHostLanes } from '@/features/chat/hostLaneEditing'
import { NoFolders } from '@/features/sessions/RemoteHostLanes'
import { WaitingNote } from '@/components/Waiting'
import { HostOrbit } from './HostOrbit'

const NO_LANES: readonly HostLaneView[] = []

/**
 * A Host's home is its lanes at a glance, not a second copy of the sidebar: the orbit
 * counts what needs you and opens any lane, and the sidebar or Lanes lists them all.
 */
export function HostHome({ hostId }: { hostId: string }): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  useMachinesStore((s) => s.machines)
  const label = machineLabel(hostId)
  const error = useRemoteLanesStore((s) => s.error)
  const pending = useRemoteLanesStore((s) => hostPending(s, hostId))
  const refusal = hostFeatureRefusal(host, 'sessions.read')
  const ready = useMachineCaps(hostId).ready
  const editing = useLaneEditing(hostId)
  const lanes = useMemo(
    () => (!host ? NO_LANES : editing ? visibleHostLanes(host.lanes) : host.lanes),
    [host, editing],
  )
  // The composer below names the machine it waits for; this waits for the lanes.
  const status = pending ? (
    <WaitingNote>Loading lanes…</WaitingNote>
  ) : refusal ? (
    <p className="text-text-secondary text-sm">{refusal}</p>
  ) : ready && host && !host.repositories.length && !host.lanes.length ? (
    <NoFolders hostId={hostId} className="items-center" />
  ) : undefined
  return (
    <section aria-label="Host home">
      <HostOrbit
        hostId={hostId}
        label={label}
        lanes={status ? NO_LANES : lanes}
        ready={ready}
        status={status}
      />
      <div className="host-home-machine">
        <h2>{label}</h2>
        {host?.state !== 'ready' && <span>· {connectionLabel(host?.state)}</span>}
      </div>
      {error && (
        <p role="alert" className="text-warning mt-2 text-center text-sm">
          {error}
        </p>
      )}
    </section>
  )
}
