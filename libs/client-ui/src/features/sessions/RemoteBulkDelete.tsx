import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { remotePrKey } from '@shared/host-protocol-github'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { pullRequestFor, usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { Button } from '@/components/form'
import { BulkDeleteModal } from './BulkDeleteModal'
import { lanesOwningWorktree, type LanePreflight, type PreflightSummary } from './deletePreflight'
import { canDeleteRemoteLane, deleteRemoteLanes, remoteLaneKey } from './deleteRemoteLanes'
import { RemoteLanePresentation, useRemoteLaneTitle } from './RemoteLanePresentation'

export function RemoteBulkDelete({
  hostId,
  lanes,
  mode,
  onClose,
}: {
  hostId: string
  lanes: HostLaneView[]
  mode: 'all' | 'merged'
  onClose: () => void
}): React.JSX.Element {
  const prState = usePullRequestsStore((s) => s.byRepo)
  const prFor = (lane: HostLaneView) =>
    pullRequestFor({ byRepo: prState }, remotePrKey(hostId, lane.repositoryId), lane.branch)
  const [selected, setSelected] = useState(
    () =>
      new Set(
        lanes
          .filter(
            (lane) =>
              canDeleteRemoteLane(hostId, lane) &&
              (mode === 'all' || prFor(lane)?.state === 'MERGED'),
          )
          .map((l) => l.laneId),
      ),
  )
  const [confirming, setConfirming] = useState(false)
  const running = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  const chosen = lanes.filter((l) => selected.has(l.laneId) && canDeleteRemoteLane(hostId, l))
  const summary = preflight(hostId, chosen)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-2 py-2" data-testid="remote-bulk-bar">
        <span className="text-sm">{chosen.length} selected</span>
        <Button size="xs" disabled={!chosen.length || running} onClick={() => setConfirming(true)}>
          Delete…
        </Button>
        <Button size="xs" onClick={onClose}>
          Cancel
        </Button>
        <p className="text-text-tertiary w-full text-xs">
          Only lanes you control can be selected. Dirty worktrees are kept by the Host.
        </p>
      </div>
      {lanes.map((lane) => (
        <SelectableLane
          key={lane.laneId}
          hostId={hostId}
          lane={lane}
          selected={selected.has(lane.laneId)}
          disabled={running || !canDeleteRemoteLane(hostId, lane)}
          onToggle={() =>
            setSelected((previous) => {
              const next = new Set(previous)
              if (next.has(lane.laneId)) next.delete(lane.laneId)
              else next.add(lane.laneId)
              return next
            })
          }
        />
      ))}
      {confirming && (
        <BulkDeleteModal
          remote
          summary={summary}
          onCancel={() => setConfirming(false)}
          onConfirm={(options) => {
            void deleteRemoteLanes(hostId, chosen, options)
            onClose()
          }}
        />
      )}
    </>
  )
}
function SelectableLane({
  hostId,
  lane,
  selected,
  disabled,
  onToggle,
}: {
  hostId: string
  lane: HostLaneView
  selected: boolean
  disabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  const title = useRemoteLaneTitle(lane, hostId)
  return (
    <RemoteLanePresentation
      hostId={hostId}
      lane={lane}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      marker={
        <span
          role="checkbox"
          aria-label={`Select ${title}`}
          aria-checked={selected}
          className="border-border text-accent grid h-4 w-4 shrink-0 place-items-center rounded border text-xs"
        >
          {selected ? '✓' : ''}
        </span>
      }
    />
  )
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
      path: remoteLaneKey(hostId, l.laneId),
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
