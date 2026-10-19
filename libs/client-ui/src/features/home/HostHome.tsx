import { useMachinesStore } from '@/stores/machines'
import {
  useRemoteLanesStore,
  connectionLabel,
  openRemoteLane,
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
} from '@/stores/remoteLanes'
import { RemoteLaneRow } from './RemoteLaneRow'
import './remoteStart.css'

/** A Host has a lane snapshot, not This Mac's project ledger or spend statistics. */
export function HostHome({ hostId }: { hostId: string }): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const label = useMachinesStore((s) => s.machines.find((m) => m.id === hostId)?.label ?? hostId)
  const error = useRemoteLanesStore((s) => s.error)
  const refusal =
    host?.state !== 'ready'
      ? REMOTE_NOT_READY
      : !host.capabilities.includes('sessions.read')
        ? REMOTE_UNAVAILABLE
        : null
  return (
    <section aria-label="Host home">
      <p className="text-text-secondary mb-2 font-mono text-xs uppercase tracking-wider">
        {connectionLabel(host?.state)}
      </p>
      <h2 className="text-lg font-medium">{label}</h2>
      {refusal ? (
        <p className="text-text-secondary mt-4">{refusal}</p>
      ) : (
        <>
          <p className="text-text-secondary mt-1 text-sm">Your lanes on {label}</p>
          <div className="remote-lane-list">
            {host?.lanes.map((lane) => (
              <RemoteLaneRow
                key={lane.laneId}
                lane={lane}
                onOpen={() => void openRemoteLane(hostId, lane.laneId)}
              />
            ))}
          </div>
          {host?.lanes.length === 0 && (
            <p className="text-text-secondary mt-4">No lanes yet. Describe a task below.</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-warning mt-4">
          {error}
        </p>
      )}
    </section>
  )
}
