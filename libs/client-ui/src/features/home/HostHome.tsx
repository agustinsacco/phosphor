import { Button } from '@/components/form'
import { useMachinesStore } from '@/stores/machines'
import {
  useRemoteLanesStore,
  connectionLabel,
  openRemoteLane,
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
} from '@/stores/remoteLanes'
import { LaneCard } from './LaneCard'

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
      <h1 className="text-4xl font-semibold tracking-tight">{label}</h1>
      {refusal ? (
        <p className="text-text-secondary mt-4">{refusal}</p>
      ) : (
        <>
          <p className="text-text-secondary mt-2 text-lg">Your lanes on {label}</p>
          <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4">
            {host?.lanes.map((lane) => (
              <LaneCard
                key={lane.laneId}
                title={lane.title ?? 'Untitled lane'}
                status={
                  <span className="text-text-secondary uppercase tracking-wider">
                    {lane.activity}
                  </span>
                }
                branch={lane.branch}
                onOpen={() => void openRemoteLane(hostId, lane.laneId)}
                action={
                  <Button size="sm" onClick={() => void openRemoteLane(hostId, lane.laneId)}>
                    Open lane
                  </Button>
                }
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
