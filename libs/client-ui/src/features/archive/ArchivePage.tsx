import { orderedHostIds, serviceScope, localServiceId } from '@/stores/localServiceScope'
import { PageShell } from '@/components/PageShell'
import { usePlatform } from '@/platform/Platform'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { pageMachine, useMachinePagesStore } from '@/stores/machinePages'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { ArchiveMachine } from './ArchiveMachine'

export function ArchivePage(): React.JSX.Element {
  const { localLanes } = usePlatform()
  const filter = useRemoteLanesStore((state) => state.filter)
  const hosts = useRemoteLanesStore((state) => state.hosts)
  const choice = useMachinePagesStore((state) => state.archiveMachine)
  const machine = serviceScope(pageMachine(filter, choice, true), hosts)
  const machines =
    machine === 'all'
      ? [...(localLanes && !localServiceId(hosts) ? ['local'] : []), ...orderedHostIds([], hosts)]
      : [machine]
  return (
    <PageShell
      title="Archive"
      actions={
        <MachinePicker
          value={machine === 'all' ? '' : machine}
          includeAll
          capability="sessions.read"
          onChange={(id) => useMachinePagesStore.setState({ archiveMachine: id || 'all' })}
        />
      }
    >
      <div className="mx-auto max-w-4xl space-y-6 p-5">
        <p className="text-text-secondary text-sm">
          Archived lanes are stopped. Their conversations and entire checkouts stay on their
          original machine, without automatic expiry. Restore a lane or explicitly clean it up
          below.
        </p>
        {!machines.length && <p>No connected machines. Connect a Host to see its archives.</p>}
        {machines.map((id) =>
          id === 'local' && !localLanes ? (
            <p key={id}>Local archives require Desktop.</p>
          ) : (
            <ArchiveMachine key={`${id}:${machineReadGeneration(id)}`} machine={id} />
          ),
        )}
      </div>
    </PageShell>
  )
}
