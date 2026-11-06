import type { ComponentProps } from 'react'
import { remoteLaneKey } from '@shared/remote-host'
import type { HostLaneView } from '@shared/ipc'
import { useSessionsStore } from '@/stores/sessions'
import { RemoteLaneRow } from './RemoteLaneRow'
import { SessionList } from './SessionList'

type RemoteLaneRowExtras = Pick<ComponentProps<typeof RemoteLaneRow>, 'workspaceName' | 'select'>

/**
 * A reorderable list of one Host's lane rows (Pinned and each folder): the open
 * lane shows as active, and reordering stops while the Host is not ready or a
 * bulk delete runs.
 */
export function RemoteLaneList({
  hostId,
  lanes,
  ready,
  disabled = false,
  row,
}: {
  hostId: string
  lanes: HostLaneView[]
  ready: boolean
  /** The caller's own reasons to stop reordering (a search or a selection). */
  disabled?: boolean
  row?: (lane: HostLaneView) => RemoteLaneRowExtras
}): React.JSX.Element {
  const active = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId] : undefined,
  )
  const deleting = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  return (
    <SessionList
      disabled={!ready || disabled || deleting}
      items={lanes.map((lane) => ({
        id: lane.laneId,
        path: remoteLaneKey(hostId, lane.laneId),
        content: (
          <RemoteLaneRow
            hostId={hostId}
            lane={lane}
            ready={ready}
            active={
              active?.target?.kind === 'remote' &&
              active.target.hostId === hostId &&
              active.laneId === lane.laneId
            }
            {...row?.(lane)}
          />
        ),
      }))}
    />
  )
}
