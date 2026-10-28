import type { HostConnectionView } from '@shared/ipc'
import { useMachinesStore } from '@/stores/machines'
import { WaitingNote } from '@/components/Waiting'
import {
  useRemoteLanesStore,
  connectingTo,
  connectionLabel,
  hostReconnecting,
} from '@/stores/remoteLanes'
import { RemoteHostLanes } from '@/features/sessions/RemoteHostLanes'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import '@/features/home/remoteStart.css'
import { Button } from '@/components/form'

/** The phone's lane list, and where a lane's Back goes: the same Host lane lists as Desktop's sidebar. */
export function CompactLanes({ machine }: { machine?: string }): React.JSX.Element {
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading)
  const error = useMachinesStore((s) => s.error)
  const snapshotStatus = useRemoteLanesStore((s) => s.snapshotStatus)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const selected = machines.filter((m) => !machine || m.id === machine)
  return (
    <PageShell title="Lanes" dismissible={false}>
      <PageBody>
        <section className="space-y-4" aria-label="Lanes">
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
            <MachineLaneList key={machine.id} machine={machine} host={hosts[machine.id]} />
          ))}
        </section>
      </PageBody>
    </PageShell>
  )
}

function MachineLaneList({
  machine,
  host,
}: {
  machine: { id: string; label: string }
  host?: HostConnectionView
}): React.JSX.Element {
  // While the Host retries, its last-known lanes stay listed; their rows hold actions until ready.
  const readable =
    !!host &&
    (host.state === 'ready' || hostReconnecting(host.state)) &&
    host.capabilities.includes('sessions.read')
  const lanes = readable ? host.lanes : []
  return (
    <section key={machine.id} className="space-y-3">
      <h2 className="font-semibold">
        {machine.label} · {connectionLabel(host?.state)}
      </h2>
      {hostReconnecting(host?.state) && (
        <WaitingNote>{connectingTo(machine.id, host?.state)}</WaitingNote>
      )}
      {!readable ? (
        !hostReconnecting(host?.state) && (
          <p role="status">
            {host?.state === 'ready'
              ? 'Lane reading is unavailable on this Host.'
              : 'Machine not connected. Its lanes may need attention.'}
          </p>
        )
      ) : lanes.length === 0 && host.repositories.length === 0 && host.state !== 'ready' ? (
        <p>No lanes yet.</p>
      ) : (
        <RemoteHostLanes
          hostId={machine.id}
          repositories={host.repositories}
          lanes={lanes}
          density="page"
        />
      )}
    </section>
  )
}
