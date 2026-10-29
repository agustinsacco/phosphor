import { useState } from 'react'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { Button } from '@/components/form'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { canReadHost, machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { compareLanesByCreation, groupRemoteLanes } from './groupRemoteLanes'
import { RemoteLaneRow } from './RemoteLaneRow'
import { RemoteRepositoryGroup, type RemoteLaneDensity } from './RemoteRepositoryGroup'
import { SectionLabel } from './SidebarPrimitives'

/**
 * One Host's lanes, as every surface lists them (Desktop's sidebar, the
 * browser's navigation and Lanes page, Host home): pinned lanes first in their
 * own section, as local pinned lanes are, then one group per folder in the
 * Host's order. A ready Host with no folders offers Add folder instead.
 */
export function RemoteHostLanes({
  hostId,
  repositories,
  lanes,
  density,
}: Pick<HostConnectionView, 'repositories' | 'lanes'> & {
  hostId: string
  density?: RemoteLaneDensity
}): React.JSX.Element {
  const ready = useRemoteLanesStore((s) => s.hosts[hostId]?.state === 'ready')
  if (ready && !repositories.length && !lanes.length) return <NoFolders hostId={hostId} />
  const pinned = lanes.filter((lane) => lane.pinned).sort(compareLanesByCreation)
  return (
    <>
      {pinned.length > 0 && (
        <PinnedRemoteLanes hostId={hostId} repositories={repositories} lanes={pinned} />
      )}
      {groupRemoteLanes(
        repositories,
        lanes.filter((lane) => !lane.pinned),
      ).map((group) => (
        <RemoteRepositoryGroup
          key={group.repositoryId}
          hostId={hostId}
          group={group}
          density={density}
        />
      ))}
    </>
  )
}

/** Pinned Host lanes across folders, each naming its folder, as local pinned rows do. */
function PinnedRemoteLanes({
  hostId,
  repositories,
  lanes,
}: {
  hostId: string
  repositories: HostConnectionView['repositories']
  lanes: HostLaneView[]
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const ready = !!host && canReadHost(host) && host.state === 'ready'
  const active = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId] : undefined,
  )
  return (
    <section aria-label="Pinned" className={!ready ? 'opacity-50' : undefined}>
      <SectionLabel>Pinned</SectionLabel>
      {lanes.map((lane) => (
        <RemoteLaneRow
          key={lane.laneId}
          hostId={hostId}
          lane={lane}
          ready={ready}
          workspaceName={repositories.find((r) => r.id === lane.repositoryId)?.name}
          active={
            active?.target?.kind === 'remote' &&
            active.target.hostId === hostId &&
            active.laneId === lane.laneId
          }
        />
      ))}
    </section>
  )
}

/** A ready Host with no folders: the one next step is adding one, so offer it right here. */
function NoFolders({ hostId }: { hostId: string }): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [adding, setAdding] = useState(false)
  const writable = !!host?.capabilities.includes('workspaces.write')
  return (
    <div className="text-text-tertiary flex flex-col items-start gap-2 px-2 py-3 text-sm">
      <span>No folders yet</span>
      {writable && (
        <Button size="xs" onClick={() => setAdding(true)}>
          Add folder on {machineLabel(hostId)}…
        </Button>
      )}
      {adding && <HostFolderBrowser hostId={hostId} onClose={() => setAdding(false)} />}
    </div>
  )
}
