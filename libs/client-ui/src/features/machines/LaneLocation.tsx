import { BranchIcon } from '@/components/icons'
import { useSessionsStore } from '@/stores/sessions'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'

const CHIP =
  'bg-bg-secondary text-text-secondary flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-sm'

/**
 * Where a Host lane works: its repository, `wt` for a worktree, and its branch.
 *
 * This Mac's top bar answers "where am I working" with the folder and branch
 * controls, which act on this machine's disk. A Host lane's answer is its Host
 * summary, whose branch follows the lane folder after every run, so a branch the
 * agent switched to reads the same here and in the lane's row. Read-only: the
 * branch menu's actions are This Mac's.
 */
export function LaneLocation({
  hostId,
  laneId,
}: {
  hostId: string
  laneId: string
}): React.JSX.Element | null {
  const lane = useRemoteLanesStore((s) =>
    s.hosts[hostId]?.lanes.find((item) => item.laneId === laneId),
  )
  const repository = useRemoteLanesStore((s) =>
    lane ? s.hosts[hostId]?.repositories.find((item) => item.id === lane.repositoryId) : undefined,
  )
  if (!lane || (!repository && !lane.branch)) return null
  const where = `${repository?.name ?? 'Repository'} on ${machineLabel(hostId)}`
  return (
    <span data-testid="lane-location" className="flex min-w-0 shrink items-center gap-2">
      {repository && (
        <span className={CHIP} data-tooltip={lane.cwd}>
          <span className="truncate">{repository.name}</span>
        </span>
      )}
      {lane.branch && (
        <span
          className={CHIP}
          data-testid="lane-branch"
          data-tooltip={lane.worktree ? `Worktree of ${where}` : `Branch ${lane.branch}`}
        >
          {lane.worktree && (
            <span className="bg-accent-soft text-accent rounded px-1 text-2xs font-medium">wt</span>
          )}
          <BranchIcon size={10} />
          <span className="max-w-36 truncate">{lane.branch}</span>
        </span>
      )}
    </span>
  )
}

/** The active session's Host lane location; nothing for a lane on This Mac. */
export function SessionLaneLocation({
  sessionId,
}: {
  sessionId: string
}): React.JSX.Element | null {
  const entry = useSessionsStore((s) => s.live[sessionId])
  if (entry?.target?.kind !== 'remote' || !entry.laneId) return null
  return <LaneLocation hostId={entry.target.hostId} laneId={entry.laneId} />
}
