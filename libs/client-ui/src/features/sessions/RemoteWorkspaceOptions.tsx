import { useState } from 'react'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import type { RemoteLaneGroup } from './groupRemoteLanes'
import { RemoteFolderMenuRows } from './RemoteFolderMenuRows'
import { RemoteRepositoryRemoval } from './RemoteRepositoryRemoval'
import { LaneGroupOptions } from './LaneGroup'
import type { LaneSelectMode } from './LaneSelectionRows'

/** A Host folder's "⋯" menu on the shared `LaneGroupOptions`: its folder rows and the dialogs they open. */
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
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
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
      <LaneGroupOptions
        name={group.name}
        className={className}
        selection={{ canSelect, selecting, collapsed, onCollapse, onSelect }}
        folderRows={(close) => (
          <RemoteFolderMenuRows
            hostId={hostId}
            repositoryId={group.repositoryId}
            onAdd={() => setAdding(true)}
            onRemove={() => setRemoving(true)}
            onDone={close}
          />
        )}
      />
    </>
  )
}
