import { useEffect, useId } from 'react'
import { PlusIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { sessionTitle } from '@/lib/sessionTitle'
import { useNavigation } from '@/navigation/Navigation'
import { useMachineCaps } from '@/stores/machineCaps'
import { pullRequestFor, usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { remotePrKey } from '@shared/host-protocol-github'
import type { HostLaneView } from '@shared/ipc'
import { RemoteBulkDelete, selectableLanes } from './RemoteBulkDelete'
import { canDeleteRemoteLane } from './deleteRemoteLanes'
import {
  clearLaneSelection,
  selectLanes,
  toggleLane,
  useLaneSelection,
  useSelectedKeys,
} from './laneSelection'
import { TAKE_CONTROL_FIRST } from './remoteLaneActions'
import { RemoteWorkspaceOptions } from './RemoteWorkspaceOptions'
import type { LaneSelectMode } from './LaneSelectionRows'
import { RemoteLaneList } from './RemoteLaneList'
import { useRemotePullRequests } from './remotePullRequests'
import { orderedRemoteLanes, type RemoteLaneGroup } from './groupRemoteLanes'
import { remoteLaneGroupKey } from './laneReveal'
import { LaneGroup, type LaneGroupDensity } from './LaneGroup'
import { useGroupSearch } from './groupSearch'
import { ensureSidebarPrefs, useGroupCollapsed } from './groupCollapse'
import type { LaneSearchFields } from './laneSearch'
import { useLiveSessionNames } from './useLiveSessionNames'

/**
 * One Host folder and its lanes, in every list of Host lanes, on the shared
 * `LaneGroup`: the workspace options menu (lane selection for bulk delete,
 * collapse, folder rows), New lane in this folder, and the shared lane rows.
 */
export function RemoteRepositoryGroup({
  hostId,
  group,
  density = 'sidebar',
}: {
  hostId: string
  group: RemoteLaneGroup
  density?: LaneGroupDensity
}): React.JSX.Element {
  const { repositoryId, name, available } = group
  const caps = useMachineCaps(hostId)
  const lanes = useRemoteLaneOrder(hostId, group.lanes)
  const groupKey = remoteLaneGroupKey(hostId, repositoryId)
  useEffect(ensureSidebarPrefs, [])
  const [collapsed, setCollapsed] = useGroupCollapsed(groupKey)
  useRemotePullRequests(hostId, repositoryId, !collapsed && available)
  const search = useGroupSearch()
  const visible = search.filter(lanes, useHostLaneFields(hostId, repositoryId, search.applied))
  const ready = caps.can('sessions.read')
  const canSelect = caps.can('sessions.read', 'workspaces.write', 'sessions.control')
  const selection = useFolderSelection(hostId, groupKey, canSelect, visible)
  return (
    <LaneGroup
      groupKey={groupKey}
      name={name}
      badge={!ready && <LastKnown />}
      collapse={[collapsed, setCollapsed]}
      search={search}
      total={lanes.length}
      shown={visible.length}
      density={density}
      controls={(className) =>
        available && (
          <>
            <RemoteWorkspaceOptions
              hostId={hostId}
              group={group}
              canSelect={canSelect}
              selecting={selection.selecting}
              collapsed={collapsed}
              className={className}
              onCollapse={setCollapsed}
              onSelect={selection.select}
            />
            <NewLaneButton hostId={hostId} group={group} className={className} />
          </>
        )
      }
      notice={
        available ? undefined : 'Not in this Host’s current folders. Delete a lane from its menu.'
      }
      dimmed={!ready}
      rows={
        <GroupLanes
          hostId={hostId}
          lanes={visible}
          ready={ready}
          query={search.query}
          select={selection.rows}
        />
      }
      bulkDelete={<RemoteBulkDelete hostId={hostId} selectionKey={selection.key} lanes={lanes} />}
    />
  )
}

/** Host lanes as this device's user arranged them (the sidebar's `sessionOrder`). */
export function useRemoteLaneOrder(hostId: string, lanes: HostLaneView[]): HostLaneView[] {
  return orderedRemoteLanes(
    hostId,
    lanes,
    useSessionsStore((s) => s.sessionOrder),
  )
}

interface FolderRowsSelection {
  group: string
  selecting: boolean
  selected: readonly string[]
  /** The lanes a shift range spans: those this client may delete, as the search shows them. */
  order: string[]
}

/**
 * This folder's hold on the one lane selection. A folder can show in two lists
 * at once (Desktop's sidebar and Host home), so each list keys its own, as each
 * of This Mac's lists would.
 */
function useFolderSelection(
  hostId: string,
  groupKey: string,
  canSelect: boolean,
  visible: HostLaneView[],
) {
  const key = `${groupKey}@${useId()}`
  const selecting = useLaneSelection((s) => s.group === key)
  const selected = useSelectedKeys(key)
  const rows: FolderRowsSelection | undefined = canSelect
    ? { group: key, selecting, selected, order: selectableLanes(hostId, visible, 'all') }
    : undefined
  const select = (mode: LaneSelectMode): void => {
    if (mode === 'clear') clearLaneSelection()
    else selectLanes(key, selectableLanes(hostId, visible, mode))
  }
  return { key, selecting, rows, select }
}

const NONE: Readonly<Record<string, never>> = Object.freeze({})

/**
 * What a Host lane is found by, as This Mac's are: its title (the live name
 * first), its branch, or its pull request. Nothing is subscribed until a
 * search is applied.
 */
function useHostLaneFields(hostId: string, repositoryId: string, applied: boolean) {
  const byRepo = usePullRequestsStore((s) => (applied ? s.byRepo : NONE))
  const live = useSessionsStore((s) => (applied ? s.live : NONE))
  // This Host's open lanes, by lane id: their live names lead the Host summary.
  const liveNames = useLiveSessionNames(applied, (sessionId) => {
    const entry = live[sessionId]
    return entry?.target?.kind === 'remote' && entry.target.hostId === hostId
      ? entry.laneId
      : undefined
  })
  return (lane: HostLaneView): LaneSearchFields => ({
    title:
      sessionTitle({ explicitName: liveNames.get(lane.laneId) ?? lane.title }, { elide: false }) ??
      '',
    branch: lane.branch ?? undefined,
    pr: pullRequestFor({ byRepo }, remotePrKey(hostId, repositoryId), lane.branch),
  })
}

/** A Host that is not ready shows its folders as last known. */
function LastKnown(): React.JSX.Element {
  return (
    <span className="text-text-tertiary shrink-0 rounded bg-chip px-1 text-2xs font-normal normal-case tracking-normal">
      last known
    </span>
  )
}

/** The group's rows; with `select`, each row carries its box in this group's selection. */
function GroupLanes({
  hostId,
  lanes,
  ready,
  query,
  select,
}: {
  hostId: string
  lanes: HostLaneView[]
  ready: boolean
  query: string
  select?: FolderRowsSelection
}): React.JSX.Element {
  return (
    <RemoteLaneList
      hostId={hostId}
      lanes={lanes}
      ready={ready}
      disabled={!!query || !!select?.selecting}
      row={(lane) => ({
        select: select && {
          selected: select.selected.includes(lane.laneId),
          selecting: select.selecting,
          blocked: canDeleteRemoteLane(hostId, lane) ? undefined : TAKE_CONTROL_FIRST,
          onToggle: (shiftKey) => toggleLane(select.group, select.order, lane.laneId, shiftKey),
        },
      })}
    />
  )
}

/** "+": the start composer for this Host, with this folder chosen, in either shell. */
function NewLaneButton({
  hostId,
  group,
  className,
}: {
  hostId: string
  group: RemoteLaneGroup
  className: string
}): React.JSX.Element {
  const { navigate } = useNavigation()
  const caps = useMachineCaps(hostId)
  const refusal = caps.refusal('sessions.control')
  return (
    <TooltipButton
      className={className}
      aria-label={`New lane in ${group.name}`}
      title={refusal ?? 'New session here'}
      disabled={refusal !== undefined}
      onClick={() => {
        openRemoteComposer(hostId, group.repositoryId)
        navigate({ to: 'new', machine: hostId })
      }}
    >
      <PlusIcon size={12} strokeWidth={2.5} />
    </TooltipButton>
  )
}
