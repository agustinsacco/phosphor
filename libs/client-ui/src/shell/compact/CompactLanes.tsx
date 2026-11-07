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
import { WorkspaceGroupSkeletons } from '@/features/sessions/SidebarPrimitives'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import '@/features/home/remoteStart.css'
import { Button } from '@/components/form'
import { MachineScopeChips } from './MachineScopeChips'

/** The browser's lane list for one machine, or every machine's lists: Desktop's sidebar lists. */
export function CompactLanes({ machine }: { machine?: string }): React.JSX.Element {
  const machines = useMachinesStore((s) => s.machines)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const selected = machines.filter((m) => !machine || m.id === machine)
  return (
    <PageShell title="Lanes" dismissible={false}>
      <MachineScopeChips machine={machine} />
      <PageBody>
        <section className="space-y-4" aria-label="Lanes">
          <LaneListNotices empty={selected.length === 0} machine={machine} />
          {selected.map((machine) => (
            <MachineLaneList key={machine.id} machine={machine} host={hosts[machine.id]} />
          ))}
        </section>
      </PageBody>
    </PageShell>
  )
}

/** Loading, refresh failures and an empty account: the same words over every lane list. */
export function LaneListNotices({
  empty,
  machine,
}: {
  empty: boolean
  machine?: string
}): React.JSX.Element {
  const loading = useMachinesStore((s) => s.loading)
  const error = useMachinesStore((s) => s.error)
  const snapshotStatus = useRemoteLanesStore((s) => s.snapshotStatus)
  return (
    <>
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
      {!loading && !error && empty && (
        <p>
          {machine
            ? 'This machine is no longer available.'
            : 'No machines yet. Add a Host from Machines.'}
        </p>
      )}
    </>
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
  // Before the first snapshot the Host is unknown, not down: skeletons, as in the sidebar.
  const firstLoad = useRemoteLanesStore((s) => !host && s.snapshotStatus === 'loading')
  return (
    <section key={machine.id} className="space-y-3">
      <h2 className="font-semibold">
        {machine.label} · {connectionLabel(host?.state)}
      </h2>
      {hostReconnecting(host?.state) && (
        <WaitingNote>{connectingTo(machine.id, host?.state)}</WaitingNote>
      )}
      {firstLoad ? (
        <WorkspaceGroupSkeletons />
      ) : !readable ? (
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
