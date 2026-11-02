import { useRef, useState } from 'react'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { MoreIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import type { RemoteLaneGroup } from './groupRemoteLanes'
import { RemoteFolderMenuRows } from './RemoteFolderMenuRows'
import { RemoteRepositoryRemoval } from './RemoteRepositoryRemoval'

/** The "⋯" menu: the Host's folder rows, lane selection for bulk delete, and collapse. */
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
          <RemoteFolderMenuRows
            hostId={hostId}
            repositoryId={group.repositoryId}
            onAdd={() => setAdding(true)}
            onRemove={() => setRemoving(true)}
            onDone={() => setMenu(false)}
          />
          <LaneSelectionRows
            canSelect={canSelect}
            selecting={selecting}
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

export type LaneSelectMode = 'all' | 'merged' | 'clear'
const SELECT_LABELS: Record<LaneSelectMode, string> = {
  all: 'Select all lanes',
  merged: 'Select merged lanes',
  clear: 'Clear selection',
}

/** Select lanes for bulk delete, and collapse: the group's own rows under the folder rows. */
function LaneSelectionRows({
  canSelect,
  selecting,
  collapsed,
  onCollapse,
  onSelect,
  onDone,
}: {
  canSelect: boolean
  selecting: boolean
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  onSelect: (mode: LaneSelectMode) => void
  onDone: () => void
}): React.JSX.Element {
  return (
    <>
      {([selecting ? 'clear' : 'all', 'merged'] as const).map((mode) => (
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
          {SELECT_LABELS[mode]}
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
