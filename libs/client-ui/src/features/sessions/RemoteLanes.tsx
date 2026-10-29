import { RemoteHostLanes } from './RemoteHostLanes'
import { MachineLabelLine, machineStateText } from './MachineSwitcher'
export { LAST_FOLDER_REFUSAL } from './RemoteRepositoryRemoval'
import { useMachinesStore } from '@/stores/machines'
import {
  REMOTE_NOT_READY,
  canReadHost,
  machineLabel,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'

export function RemoteLanes(): React.JSX.Element | null {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const filter = useRemoteLanesStore((s) => s.filter)
  const enabled = useMachinesStore((s) => s.remoteEnabled)
  const machines = useMachinesStore((s) => s.machines)
  const now = useMachinesStore((s) => s.nowMs + s.clockOffsetMs)
  const error = useRemoteLanesStore((s) => s.error)
  const loading = useRemoteLanesStore((s) => s.snapshotStatus === 'loading')
  if (!enabled || filter === 'local') return null
  const ids =
    filter === 'all'
      ? [...new Set([...machines.map((m) => m.id), ...Object.keys(hosts)])]
      : [filter]
  return (
    <>
      {ids
        .filter((id) => !hosts[id] || hosts[id]?.state === 'no-address' || canReadHost(hosts[id]!))
        .map((id) => (
          <section key={id} aria-label={machineLabel(id)}>
            {filter === 'all' && <MachineLabelLine id={id} />}
            {hosts[id]?.state !== 'no-address' && hosts[id] && canReadHost(hosts[id]) ? (
              <RemoteHostLanes
                hostId={id}
                repositories={hosts[id].repositories}
                lanes={hosts[id].lanes}
              />
            ) : (
              <div className="text-text-tertiary px-2 py-3 text-sm">
                {!hosts[id] || hosts[id].state === 'no-address'
                  ? machineStateText(
                      hosts[id],
                      machines.find((m) => m.id === id),
                      now,
                      loading,
                    )
                  : REMOTE_NOT_READY}
              </div>
            )}
          </section>
        ))}
      {error && (
        <p className="text-danger px-2 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
