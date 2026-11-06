import { useRef, useState } from 'react'
import { PopupMenu } from '@/components/PopupMenu'
import { MoreIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import type { RemoteLaneGroup } from './groupRemoteLanes'
import { RemoteFolderMenuRows } from './RemoteFolderMenuRows'
import { RemoteRepositoryRemoval } from './RemoteRepositoryRemoval'
import { LaneSelectionRows, type LaneSelectMode } from './LaneSelectionRows'

/** The "⋯" menu in This Mac's order: lane selection for bulk delete, collapse, then the Host's folder rows. */
export function RemoteWorkspaceOptions({
  hostId,
  group,
  canSelect,
  selecting,
  collapsed,
  className,
  onCollapse,
  onSelect,
}: {
  hostId: string
  group: RemoteLaneGroup
  canSelect: boolean
  /** This group has the selection: "Select all lanes" becomes "Clear selection". */
  selecting: boolean
  collapsed: boolean
  className: string
  onCollapse: (collapsed: boolean) => void
  onSelect: (mode: LaneSelectMode) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
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
          <LaneSelectionRows
            canSelect={canSelect}
            selecting={selecting}
            collapsed={collapsed}
            onCollapse={onCollapse}
            onSelect={onSelect}
            onDone={() => setMenu(false)}
          />
          <RemoteFolderMenuRows
            hostId={hostId}
            repositoryId={group.repositoryId}
            onAdd={() => setAdding(true)}
            onRemove={() => setRemoving(true)}
            onDone={() => setMenu(false)}
          />
        </PopupMenu>
      )}
    </>
  )
}
