import { MenuRow } from '@/components/PopupMenu'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { moveRemoteRepository } from './remoteRepositoryOrder'

/**
 * A Host folder's own menu rows, the same on Desktop's sidebar and in the browser: add another
 * folder, remove this one, and move it within the Host's order. All change the Host's config.
 */
export function RemoteFolderMenuRows({
  hostId,
  repositoryId,
  onAdd,
  onRemove,
  onDone,
}: {
  hostId: string
  repositoryId: string
  onAdd: () => void
  onRemove: () => void
  /** Closes the menu. */
  onDone: () => void
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const writable = host?.state === 'ready' && host.capabilities.includes('workspaces.write')
  const ids = host?.repositories.map((r) => r.id) ?? []
  const index = ids.indexOf(repositoryId)
  const move = (direction: 'up' | 'down'): void => {
    onDone()
    void moveRemoteRepository(hostId, repositoryId, direction)
  }
  return (
    <>
      <MenuRow
        active={false}
        disabled={!writable}
        onClick={() => {
          onDone()
          onAdd()
        }}
      >
        Add folder on {machineLabel(hostId)}…
      </MenuRow>
      <MenuRow
        active={false}
        disabled={!writable}
        onClick={() => {
          onDone()
          onRemove()
        }}
      >
        Remove from {machineLabel(hostId)}
      </MenuRow>
      <MenuRow active={false} disabled={!writable || index <= 0} onClick={() => move('up')}>
        Move up
      </MenuRow>
      <MenuRow
        active={false}
        disabled={!writable || index < 0 || index >= ids.length - 1}
        onClick={() => move('down')}
      >
        Move down
      </MenuRow>
    </>
  )
}
