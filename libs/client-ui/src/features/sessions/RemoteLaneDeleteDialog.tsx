import type { HostLaneView } from '@shared/ipc'
import { forgetRemoteSession } from '@/stores/sessions'
import { ArchiveSessionModal } from './ArchiveConfirm'
import { archiveRemoteLane } from './archiveRemoteLane'

/** Normal removal retains the lane; permanent cleanup lives only on Archive. */
export function RemoteLaneDeleteDialog({
  hostId,
  lane,
  title,
  sessionId,
  workspacePath,
  allowed,
  onClose,
}: {
  hostId: string
  lane: HostLaneView
  title: string
  sessionId: string | undefined
  workspacePath: string
  allowed: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <ArchiveSessionModal
      target={{ title, workspacePath }}
      onClose={onClose}
      onArchive={async () => {
        if (!allowed) throw new Error('Take control of this lane before archiving.')
        await archiveRemoteLane(hostId, lane.laneId)
        if (sessionId) await forgetRemoteSession(sessionId)
      }}
    />
  )
}
