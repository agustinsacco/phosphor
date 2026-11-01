import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { hostResourceKey } from '@shared/remote-host'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { forgetRemoteSession } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type { LanePreflight } from './deletePreflight'
import { DeleteSessionModal } from './DeleteSessionModal'
import { BulkDeleteModal } from './BulkDeleteModal'

/**
 * Delete one Host lane. A lane alone in its worktree offers the worktree and
 * branch too; a lane sharing its folder offers only itself. The Host refuses a
 * caller that is not the lane's controller, so `allowed` gates every send.
 */
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
  /** The live session bound to this lane, closed once the lane is gone. */
  sessionId: string | undefined
  workspacePath: string
  allowed: boolean
  onClose: () => void
}): React.JSX.Element {
  // A lane whose folder left the Host has nothing to prove a worktree against.
  const listed = useRemoteLanesStore(
    (s) => !!s.hosts[hostId]?.repositories.some((repo) => repo.id === lane.repositoryId),
  )
  const ownsWorktree = useRemoteLanesStore(
    (s) =>
      listed &&
      lane.worktree &&
      !s.hosts[hostId]?.lanes.some(
        (other) => other.laneId !== lane.laneId && other.cwd === lane.cwd,
      ),
  )
  const finish = async ({ branchKept }: { branchKept: boolean }): Promise<void> => {
    if (sessionId) await forgetRemoteSession(sessionId)
    if (branchKept)
      useExtensionUiStore.getState().pushToast("Branch kept: it isn't merged yet.", 'info')
  }
  if (!ownsWorktree)
    return (
      <DeleteSessionModal
        remote={listed || 'unlisted'}
        target={{ title, workspacePath }}
        onClose={onClose}
        onRemove={async () => {
          if (!allowed) throw new Error()
          const result = await window.phosphor.invoke('hosts:deleteLane', hostId, lane.laneId, {
            removeWorktree: false,
            removeBranch: false,
          })
          await finish(result)
        }}
      />
    )
  return (
    <WorktreeLaneDelete
      hostId={hostId}
      lane={lane}
      title={title}
      allowed={allowed}
      onDeleted={finish}
      onClose={onClose}
    />
  )
}

/** A lane alone in its worktree: the worktree and its branch can go with it. */
function WorktreeLaneDelete({
  hostId,
  lane,
  title,
  allowed,
  onDeleted,
  onClose,
}: {
  hostId: string
  lane: HostLaneView
  title: string
  allowed: boolean
  onDeleted: (result: { branchKept: boolean }) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preflight: LanePreflight = {
    path: hostResourceKey({ kind: 'remote', hostId }, 'session', lane.laneId),
    title,
    marker: lane.marker ?? '',
    dirtyCount: 0,
    warnings: lane.activity === 'working' ? ['running'] : [],
  }
  return (
    <BulkDeleteModal
      remote
      busy={busy}
      error={error}
      summary={{
        lanes: [preflight],
        deletable: [preflight],
        warnings: preflight.warnings,
        needsAcknowledgement: preflight.warnings.length > 0,
        worktreeCount: 1,
      }}
      onCancel={() => {
        if (!busy) onClose()
      }}
      onConfirm={(options) => {
        if (!allowed || busy) return
        setBusy(true)
        setError(null)
        void window.phosphor
          .invoke('hosts:deleteLane', hostId, lane.laneId, {
            removeWorktree: options.removeWorktree,
            removeBranch: options.removeWorktree && options.deleteBranch,
          })
          .then(async (result) => {
            await onDeleted(result)
            onClose()
          })
          .catch(() =>
            setError('The Host could not delete this lane. Check the lane before retrying.'),
          )
          .finally(() => setBusy(false))
      }}
    />
  )
}
