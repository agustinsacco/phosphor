import type { HostConnectionView } from '@shared/ipc'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore, connectionLabel, hostReconnecting } from '@/stores/remoteLanes'
import { RemoteLaneGroups } from '@/features/sessions/RemoteLaneGroups'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import '@/features/home/remoteStart.css'
import { Button } from '@/components/form'
import { useNavigation } from '@/navigation/Navigation'

export function CompactLanes({
  machine,
  inbox = false,
}: {
  machine?: string
  inbox?: boolean
}): React.JSX.Element {
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading)
  const error = useMachinesStore((s) => s.error)
  const snapshotStatus = useRemoteLanesStore((s) => s.snapshotStatus)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const selected = machines.filter((m) => !machine || m.id === machine)
  return (
    <PageShell title={inbox ? 'Inbox' : 'Lanes'} dismissible={false}>
      <PageBody>
        <section className="space-y-4" aria-label={inbox ? 'Inbox' : 'Lanes'}>
          {loading && <p role="status">Loading machines…</p>}
          {snapshotStatus === 'error' && (
            <p role="alert">
              Host status could not be refreshed. These are last-known lanes; reconnect from
              Machines.
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
          {selected.map((machine) => (
            <MachineLaneList
              key={machine.id}
              machine={machine}
              host={hosts[machine.id]}
              inbox={inbox}
            />
          ))}
        </section>
      </PageBody>
    </PageShell>
  )
}

function MachineLaneList({
  machine,
  host,
  inbox,
}: {
  machine: { id: string; label: string }
  host?: HostConnectionView
  inbox: boolean
}): React.JSX.Element {
  const { navigate } = useNavigation()
  // While the Host retries, its last-known lanes stay listed; their rows hold actions until ready.
  const readable =
    !!host &&
    (host.state === 'ready' || hostReconnecting(host.state)) &&
    host.capabilities.includes('sessions.read')
  const lanes = readable ? host.lanes.filter((lane) => !inbox || lane.attention > lane.read) : []
  return (
    <section key={machine.id} className="space-y-3">
      <h2 className="font-semibold">
        {machine.label} · {connectionLabel(host?.state)}
      </h2>
      {!readable ? (
        <p role="status">
          {host?.state === 'ready'
            ? 'Lane reading is unavailable on this Host.'
            : hostReconnecting(host?.state)
              ? 'Connecting…'
              : 'Machine not connected. Its lanes may need attention.'}
        </p>
      ) : lanes.length === 0 ? (
        <p>{inbox ? 'No unread attention on this machine.' : 'No lanes yet.'}</p>
      ) : (
        <RemoteLaneGroups
          hostId={machine.id}
          repositories={
            inbox
              ? host.repositories.filter((repository) =>
                  lanes.some((lane) => lane.repositoryId === repository.id),
                )
              : host.repositories
          }
          lanes={lanes}
          onOpen={(laneId) =>
            navigate({
              to: 'lane',
              lane: { hostId: machine.id, laneId },
              pane: 'chat',
            })
          }
        />
      )}
    </section>
  )
}
