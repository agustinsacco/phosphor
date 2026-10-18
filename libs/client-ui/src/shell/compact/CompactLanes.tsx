import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore, connectionLabel } from '@/stores/remoteLanes'
import { LaneCard } from '@/features/home/LaneCard'
import { Button } from '@/components/form'
import { useNavigation } from '@/navigation/Navigation'

export function CompactLanes({
  machine,
  inbox = false,
}: {
  machine?: string
  inbox?: boolean
}): React.JSX.Element {
  const { navigate } = useNavigation()
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading)
  const error = useMachinesStore((s) => s.error)
  const snapshotStatus = useRemoteLanesStore((s) => s.snapshotStatus)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const selected = machines.filter((m) => !machine || m.id === machine)
  return (
    <section className="compact-list" aria-label={inbox ? 'Inbox' : 'Lanes'}>
      <h1>{inbox ? 'Inbox' : 'Lanes'}</h1>
      {loading && <p role="status">Loading machines…</p>}
      {snapshotStatus === 'error' && (
        <p role="alert">
          Host status could not be refreshed. These are last-known lanes; reconnect from Machines.
        </p>
      )}
      {error && (
        <p role="alert">
          Could not refresh machines.{' '}
          <Button onClick={() => void useMachinesStore.getState().refresh()}>Retry</Button>
        </p>
      )}
      {!loading && !error && selected.length === 0 && (
        <p>
          {machine
            ? 'This machine is no longer available.'
            : 'No machines yet. Add a Host from Machines.'}
        </p>
      )}
      {selected.map((machine) => {
        const host = hosts[machine.id]
        const readable = host?.state === 'ready' && host.capabilities.includes('sessions.read')
        const lanes = readable
          ? host.lanes.filter((lane) => !inbox || lane.attention > lane.read)
          : []
        return (
          <section key={machine.id} className="space-y-3">
            <h2 className="font-semibold">
              {machine.label} · {connectionLabel(host?.state)}
            </h2>
            {!readable ? (
              <p role="status">
                {host?.state === 'ready'
                  ? 'Lane reading is unavailable on this Host.'
                  : 'Machine not connected. Its lanes may need attention.'}
              </p>
            ) : lanes.length === 0 ? (
              <p>{inbox ? 'No unread attention on this machine.' : 'No lanes yet.'}</p>
            ) : (
              lanes.map((lane) => {
                const open = (): void =>
                  navigate({
                    to: 'lane',
                    lane: { hostId: machine.id, laneId: lane.laneId },
                    pane: 'chat',
                  })
                return (
                  <LaneCard
                    key={lane.laneId}
                    title={lane.title || 'Untitled lane'}
                    branch={lane.branch}
                    status={
                      <span>
                        {lane.activity}
                        {lane.attention > lane.read ? ' · Needs attention' : ''}
                      </span>
                    }
                    onOpen={open}
                    action={<Button onClick={open}>Open lane</Button>}
                  />
                )
              })
            )}
          </section>
        )
      })}
    </section>
  )
}
