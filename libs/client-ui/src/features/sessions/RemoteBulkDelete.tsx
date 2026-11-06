import { useState } from 'react'
import { remoteLaneResourceKey } from '@shared/remote-host'
import type { HostLaneView } from '@shared/ipc'
import { remotePrKey } from '@shared/host-protocol-github'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { pullRequestFor, usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { BulkDeleteModal } from './BulkDeleteModal'
import { lanesOwningWorktree, type LanePreflight, type PreflightSummary } from './deletePreflight'
import { canDeleteRemoteLane, deleteRemoteLanes } from './deleteRemoteLanes'
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
  const chosen = lanes.filter((l) => keys.includes(l.laneId) && canDeleteRemoteLane(hostId, l))
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
        <BulkDeleteModal
          remote
          summary={preflight(hostId, chosen)}
          onCancel={() => setConfirming(false)}
          onConfirm={(options) => {
            setConfirming(false)
            clearLaneSelection()
            void deleteRemoteLanes(hostId, chosen, options)
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

function preflight(hostId: string, lanes: HostLaneView[]): PreflightSummary {
  const prs = usePullRequestsStore.getState()
  const owners = lanesOwningWorktree(
    lanes.map((l) => ({ path: l.laneId, cwd: l.cwd })),
    (useRemoteLanesStore.getState().hosts[hostId]?.lanes ?? []).map((l) => ({
      path: l.laneId,
      cwd: l.cwd,
    })),
  )
  const rows = lanes.map((l): LanePreflight => {
    const pr = pullRequestFor(prs, remotePrKey(hostId, l.repositoryId), l.branch)
    return {
      path: remoteLaneResourceKey(hostId, l.laneId),
      title: l.title || 'Untitled lane',
      marker: '',
      dirtyCount: 0,
      pr,
      warnings: [
        ...(l.activity === 'working' ? ['running' as const] : []),
        ...(pr?.state === 'OPEN' || pr?.state === 'DRAFT' ? ['open-pr' as const] : []),
      ],
    }
  })
  const warnings = [...new Set(rows.flatMap((r) => r.warnings))]
  return {
    lanes: rows,
    deletable: rows,
    warnings,
    needsAcknowledgement: warnings.length > 0,
    worktreeCount: lanes.filter((l) => l.worktree && owners.has(l.laneId)).length,
  }
}
