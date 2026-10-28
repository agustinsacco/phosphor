import { useRef, useState } from 'react'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { MoreIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import type { HostConnectionView } from '@shared/ipc'
import type { RemoteLaneGroup } from './groupRemoteLanes'
import { RemoteFolderMenuRows } from './RemoteFolderMenuRows'
import { RemoteRepositoryRemoval } from './RemoteRepositoryRemoval'

/** The "⋯" menu: the Host's folder rows, lane selection for bulk delete, and collapse. */
export function RemoteWorkspaceOptions({
  hostId,
  group,
  host,
  ready,
  collapsed,
  className,
  onCollapse,
  onSelect,
}: {
  hostId: string
  group: RemoteLaneGroup
  host: HostConnectionView | undefined
  ready: boolean
  collapsed: boolean
  className: string
  onCollapse: (collapsed: boolean) => void
  onSelect: (mode: 'all' | 'merged') => void
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const canSelect =
    ready &&
    !!host?.capabilities.includes('workspaces.write') &&
    host.capabilities.includes('sessions.control')
  return (
    <>
      {adding && <HostFolderBrowser hostId={hostId} onClose={() => setAdding(false)} />}
      {removing && (
        <RemoteRepositoryRemoval
          hostId={hostId}
          repositoryId={group.repositoryId}
          name={group.name}
          onClose={() => setRemoving(false)}
        />
      )}
      <TooltipButton
        ref={trigger}
        className={className}
        aria-label={`Workspace options for ${group.name}`}
        aria-expanded={menu}
        title="Workspace options"
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
          <LaneSelectionRows
            canSelect={canSelect}
            collapsed={collapsed}
            onCollapse={onCollapse}
            onSelect={onSelect}
            onDone={() => setMenu(false)}
          />
        </PopupMenu>
      )}
    </>
  )
}

/** Select lanes for bulk delete, and collapse: the group's own rows under the folder rows. */
function LaneSelectionRows({
  canSelect,
  collapsed,
  onCollapse,
  onSelect,
  onDone,
}: {
  canSelect: boolean
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  onSelect: (mode: 'all' | 'merged') => void
  onDone: () => void
}): React.JSX.Element {
  return (
    <>
      {(['all', 'merged'] as const).map((mode) => (
        <MenuRow
          key={mode}
          active={false}
          disabled={!canSelect}
          onClick={() => {
            onDone()
            onCollapse(false)
            onSelect(mode)
          }}
        >
          {mode === 'all' ? 'Select all lanes' : 'Select merged lanes'}
        </MenuRow>
      ))}
      <MenuRow
        active={false}
        onClick={() => {
          onCollapse(!collapsed)
          onDone()
        }}
      >
        {collapsed ? 'Expand' : 'Collapse'} lanes
      </MenuRow>
    </>
  )
}
