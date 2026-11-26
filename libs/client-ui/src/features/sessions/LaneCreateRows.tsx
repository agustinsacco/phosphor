import { useMemo } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { useNavigation } from '@/navigation/Navigation'
import { pendingLaneCreates, useLaneCreatesStore } from '@/stores/laneCreates'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { LaneRow, SessionIndicator, SubtitleSegments } from './SidebarPrimitives'

/**
 * A folder's New lane placeholders, above its lanes in every list of them
 * (Desktop's sidebar, the browser's lists): the prompt as the title,
 * Starting, or why it failed. Each gives way to its lane's row once the Host
 * lists it.
 */
const NO_LANES: readonly HostLaneView[] = []

export function LaneCreateRows({
  hostId,
  repositoryId,
  unlisted,
}: {
  hostId: string
  /** Absent: the Host's, in every folder (its lanes are not listed while it is down). */
  repositoryId?: string
  /** Down: its cached lanes are not shown, so none of them stands in for a placeholder. */
  unlisted?: boolean
}): React.JSX.Element | null {
  const { navigate } = useNavigation()
  const creates = useLaneCreatesStore((s) => s.creates)
  const cached = useRemoteLanesStore((s) => s.hosts[hostId]?.lanes)
  const lanes = unlisted ? NO_LANES : cached
  const shown = useSessionsStore((s) => s.opening?.create)
  const pending = useMemo(
    () => pendingLaneCreates(creates, hostId, repositoryId, lanes),
    [creates, hostId, repositoryId, lanes],
  )
  if (!pending.length) return null
  return (
    <>
      {pending.map((create) => (
        <LaneRow
          key={create.id}
          tooltip={create.title}
          aria-label={create.title}
          aria-current={shown === create.id ? 'page' : undefined}
          data-testid="lane-create-row"
          data-activity={create.failure ? undefined : 'starting'}
          className={shown === create.id ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}
          onClick={() => navigate({ to: 'new', machine: hostId, create: create.id })}
        >
          <SessionIndicator state="live" />
          <span className="min-w-0 flex-1">
            <span className="text-text block truncate text-lg font-medium leading-5">
              {create.title}
            </span>
            <span className="text-text-secondary flex items-center gap-1 text-base leading-4">
              {create.failure ? (
                <span className="text-warning">Couldn’t start</span>
              ) : (
                <SubtitleSegments segments={[]} activity="starting" />
              )}
            </span>
          </span>
        </LaneRow>
      ))}
    </>
  )
}
