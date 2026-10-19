import { useState } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import { RemoteLaneRow } from '@/features/home/RemoteLaneRow'
import { groupRemoteLanes, type RemoteLaneGroup } from './groupRemoteLanes'
import { WorkspaceGroupHeader, WorkspaceGroupTitle } from './SidebarPrimitives'

/** Repository groups for navigation-only surfaces. No native menus or persistence. */
export function RemoteLaneGroups({
  hostId,
  repositories,
  lanes,
  ready = true,
  onOpen,
}: Pick<HostConnectionView, 'repositories' | 'lanes'> & {
  hostId: string
  ready?: boolean
  onOpen: (laneId: string) => void
}): React.JSX.Element {
  return (
    <>
      {groupRemoteLanes(repositories, lanes).map((group) => (
        <ReadOnlyRepositoryGroup
          key={group.repositoryId}
          group={group}
          hostId={hostId}
          ready={ready}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}

function ReadOnlyRepositoryGroup({
  group,
  hostId,
  ready,
  onOpen,
}: {
  group: RemoteLaneGroup
  hostId: string
  ready: boolean
  onOpen: (laneId: string) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <section aria-label={group.name} className="min-w-0">
      <WorkspaceGroupHeader>
        <WorkspaceGroupTitle
          name={group.name}
          collapsed={collapsed}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        />
      </WorkspaceGroupHeader>
      {!group.available && (
        <p className="text-text-tertiary px-2 py-1 text-sm">Not in this Host’s current folders.</p>
      )}
      {!collapsed && (
        <div className={!ready ? 'opacity-50' : undefined}>
          {group.lanes.map((lane) => (
            <RemoteLaneRow
              key={lane.laneId}
              hostId={hostId}
              lane={lane}
              ready={ready}
              onOpen={() => onOpen(lane.laneId)}
            />
          ))}
          {!group.lanes.length && (
            <p className="text-text-tertiary px-2 py-2 text-sm">No lanes yet</p>
          )}
        </div>
      )}
    </section>
  )
}
