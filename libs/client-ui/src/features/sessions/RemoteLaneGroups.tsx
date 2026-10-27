import { useRemotePullRequests } from './remotePullRequests'
import { useRef, useState } from 'react'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { PopupMenu } from '@/components/PopupMenu'
import { MoreIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { RemoteFolderMenuRows } from './RemoteFolderMenuRows'
import { RemoteRepositoryRemoval } from './RemoteRepositoryRemoval'
import type { HostConnectionView } from '@shared/ipc'
import { RemoteLaneRow } from '@/features/home/RemoteLaneRow'
import { groupRemoteLanes, type RemoteLaneGroup } from './groupRemoteLanes'
import { WorkspaceGroupHeader, WorkspaceGroupTitle } from './SidebarPrimitives'

/**
 * Repository groups for navigation surfaces such as the browser's lane list. No native menus or
 * persistence. With `manage`, each current folder offers the Host's folder menu: add, remove and
 * move. Leave it off when `repositories` is a filtered subset, since a move needs the whole order.
 */
export function RemoteLaneGroups({
  hostId,
  repositories,
  lanes,
  ready = true,
  manage = false,
  onOpen,
}: Pick<HostConnectionView, 'repositories' | 'lanes'> & {
  hostId: string
  ready?: boolean
  manage?: boolean
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
          manage={manage && group.available}
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
  manage,
  onOpen,
}: {
  group: RemoteLaneGroup
  hostId: string
  ready: boolean
  manage: boolean
  onOpen: (laneId: string) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  useRemotePullRequests(hostId, group.repositoryId, !collapsed && group.available)
  return (
    <section aria-label={group.name} className="min-w-0">
      <WorkspaceGroupHeader>
        <WorkspaceGroupTitle
          name={group.name}
          collapsed={collapsed}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        />
        {manage && <FolderOptions hostId={hostId} group={group} />}
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

/** The Host folder menu: its trigger, its rows and the dialogs they open. */
function FolderOptions({
  hostId,
  group,
}: {
  hostId: string
  group: RemoteLaneGroup
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <TooltipButton
        ref={trigger}
        className="text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
        aria-label={`Folder options for ${group.name}`}
        aria-expanded={menu}
        title="Folder options"
        onClick={() => setMenu(!menu)}
      >
        <MoreIcon size={14} />
      </TooltipButton>
      {menu && (
        <PopupMenu
          triggerRef={trigger}
          onClose={() => setMenu(false)}
          className="absolute right-1 top-full z-40 mt-1 min-w-44 py-1"
        >
          <RemoteFolderMenuRows
            hostId={hostId}
            repositoryId={group.repositoryId}
            onAdd={() => setAdding(true)}
            onRemove={() => setRemoving(true)}
            onDone={() => setMenu(false)}
          />
        </PopupMenu>
      )}
      {adding && <HostFolderBrowser hostId={hostId} onClose={() => setAdding(false)} />}
      {removing && (
        <RemoteRepositoryRemoval
          hostId={hostId}
          repositoryId={group.repositoryId}
          name={group.name}
          onClose={() => setRemoving(false)}
        />
      )}
    </>
  )
}
