import { useState } from 'react'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { Button } from '@/components/form'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { useMachineCaps } from '@/stores/machineCaps'
import { machineLabel } from '@/stores/remoteLanes'
import { compareLanesByCreation, groupRemoteLanes } from './groupRemoteLanes'
import { RemoteLaneList } from './RemoteLaneList'
import { RemoteRepositoryGroup, useRemoteLaneOrder } from './RemoteRepositoryGroup'
import type { LaneGroupDensity } from './LaneGroup'
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
  density?: LaneGroupDensity
}): React.JSX.Element {
  const ready = useMachineCaps(hostId).ready
  const pinned = useRemoteLaneOrder(
    hostId,
    lanes.filter((lane) => lane.pinned).sort(compareLanesByCreation),
  )
  if (ready && !repositories.length && !lanes.length) return <NoFolders hostId={hostId} />
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
  const ready = useMachineCaps(hostId).can('sessions.read')
  return (
    <section aria-label="Pinned" className={!ready ? 'opacity-50' : undefined}>
      <SectionLabel>Pinned</SectionLabel>
      <RemoteLaneList
        hostId={hostId}
        lanes={lanes}
        ready={ready}
        row={(lane) => ({
          workspaceName: repositories.find((r) => r.id === lane.repositoryId)?.name,
        })}
      />
    </section>
  )
}

/** A ready Host with no folders: the one next step is adding one, so offer it right here. */
function NoFolders({ hostId }: { hostId: string }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const writable = useMachineCaps(hostId).granted('workspaces.write')
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
