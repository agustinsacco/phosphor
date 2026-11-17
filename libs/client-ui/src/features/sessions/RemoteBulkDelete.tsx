import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { remotePrKey } from '@shared/host-protocol-github'
import { pullRequestFor, usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { ArchiveConfirm } from './ArchiveConfirm'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { canArchiveRemoteLane, canDeleteRemoteLane, deleteRemoteLanes } from './deleteRemoteLanes'
import { LaneBulkBar } from './LaneSelect'
import { clearLaneSelection, useSelectedKeys, useSelectionOwner } from './laneSelection'

/**
 * A Host folder's bulk delete: the shared bulk bar and confirm over the lanes
 * selected in this group's rows. Selection itself is `laneSelection.ts`, the
 * same as This Mac's.
 */
export function RemoteBulkDelete({
  hostId,
  selectionKey,
  lanes,
}: {
  hostId: string
  /** This group's key in `laneSelection.ts`. */
  selectionKey: string
  lanes: HostLaneView[]
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false)
  const owner = useSelectionOwner([selectionKey], confirming)
  const keys = useSelectedKeys(owner)
  const running = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  if (owner === null) return null
  const chosen = lanes.filter((l) => keys.includes(l.laneId) && canArchiveRemoteLane(hostId, l))
  return (
    <>
      <LaneBulkBar
        count={chosen.length}
        running={running}
        className="sticky bottom-2 mx-2 mt-1"
        onDelete={() => setConfirming(true)}
        onCancel={clearLaneSelection}
      />
      {confirming && (
        <ArchiveConfirm
          titles={chosen.map((lane) => lane.title || 'Untitled lane')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            clearLaneSelection()
            void deleteRemoteLanes(hostId, chosen, {
              archive: true,
              removeWorktree: false,
              deleteBranch: false,
            }).catch((error: unknown) =>
              useExtensionUiStore.getState().pushToast(String(error), 'error'),
            )
          }}
        />
      )}
    </>
  )
}

/** The lanes "Select all" or "Select merged" picks in a group: those this client may delete. */
export function selectableLanes(
  hostId: string,
  lanes: HostLaneView[],
  mode: 'all' | 'merged',
): string[] {
  const prs = usePullRequestsStore.getState()
  return lanes
    .filter(
      (lane) =>
        canDeleteRemoteLane(hostId, lane) &&
        (mode === 'all' ||
          pullRequestFor(prs, remotePrKey(hostId, lane.repositoryId), lane.branch)?.state ===
            'MERGED'),
    )
    .map((lane) => lane.laneId)
}
