import { useState } from 'react'
import { orderedHostIds, serviceScope, localServiceId } from '@/stores/localServiceScope'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import { PaneTitle } from '@/components/PaneShell'
import { SettingsNotice, TextInput } from '@/components/form'
import { usePlatform } from '@/platform/Platform'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useArchivesStore } from '@/stores/archives'
import { pageMachine, useMachinePagesStore } from '@/stores/machinePages'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { ArchiveMachine } from './ArchiveMachine'

export function ArchivePage(): React.JSX.Element {
  const { localLanes } = usePlatform()
  const [query, setQuery] = useState('')
  const filter = useRemoteLanesStore((state) => state.filter)
  const hosts = useRemoteLanesStore((state) => state.hosts)
  const choice = useMachinePagesStore((state) => state.archiveMachine)
  const inventories = useArchivesStore((state) => state.machines)
  const machine = serviceScope(pageMachine(filter, choice, true), hosts)
  const machines =
    machine === 'all'
      ? [...(localLanes && !localServiceId(hosts) ? ['local'] : []), ...orderedHostIds([], hosts)]
      : [machine]
  const total = machines.reduce((sum, id) => sum + (inventories[id]?.data?.entries.length ?? 0), 0)
  return (
    <PageShell
      title={
        <PaneTitle
          label="Archive"
          meta={total ? `${total} archived lane${total === 1 ? '' : 's'}` : undefined}
        />
      }
      actions={
        <MachinePicker
          value={machine === 'all' ? '' : machine}
          includeAll
          capability="sessions.read"
          onChange={(id) => useMachinePagesStore.setState({ archiveMachine: id || 'all' })}
        />
      }
    >
      <PageBody>
        <p className="text-text-secondary mb-4 text-sm">
          Archived lanes are stopped. Their conversations and entire checkouts stay on their
          original machine, without automatic expiry. Restore a lane or clean it up below.
        </p>
        {!machines.length && (
          <SettingsNotice
            tone="info"
            title="No connected machines."
            body="Connect a Host to see its archives."
          />
        )}
        {!!total && (
          <TextInput
            aria-label="Search archived lanes"
            className="mb-4 w-full max-w-md"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search archived lanes or paths"
          />
        )}
        {machines.map((id) =>
          id === 'local' && !localLanes ? (
            <SettingsNotice key={id} tone="info" title="Local archives require Desktop." />
          ) : (
            <ArchiveMachine key={`${id}:${machineReadGeneration(id)}`} machine={id} query={query} />
          ),
        )}
      </PageBody>
    </PageShell>
  )
}
