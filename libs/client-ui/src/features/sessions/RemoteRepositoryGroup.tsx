import { useEffect, useId } from 'react'
import clsx from 'clsx'
import { SearchIcon, PlusIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { useNavigation } from '@/navigation/Navigation'
import {
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
  canReadHost,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
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
import { RemoteLaneRow } from './RemoteLaneRow'
import { useRemotePullRequests } from './remotePullRequests'
import { orderedRemoteLanes, remoteLaneOrderKey, type RemoteLaneGroup } from './groupRemoteLanes'
import { SessionList } from './SessionList'
import { remoteLaneGroupKey, useLaneReveal } from './laneReveal'
import { LaneSearchBar } from './LaneSearchBar'
import { useRemoteGroupSearch } from './remoteGroupSearch'
import { ensureGroupCollapse, setGroupCollapsed, useGroupCollapse } from './groupCollapse'
import { WorkspaceGroupHeader, WorkspaceGroupTitle } from './SidebarPrimitives'

/** `sidebar` is Desktop's dense list; `page` gives the header controls touch-sized targets. */
export type RemoteLaneDensity = 'sidebar' | 'page'

/**
 * One Host folder and its lanes, in every list of Host lanes: search, the
 * workspace options menu (folder rows, lane selection for bulk delete,
 * collapse), New lane in this folder, and the shared lane rows.
 */
export function RemoteRepositoryGroup({
  hostId,
  group,
  density = 'sidebar',
}: {
  hostId: string
  group: RemoteLaneGroup
  density?: RemoteLaneDensity
}): React.JSX.Element {
  const { repositoryId, name, available } = group
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const sessionOrder = useSessionsStore((s) => s.sessionOrder)
  const lanes = orderedRemoteLanes(hostId, group.lanes, sessionOrder)
  const groupKey = remoteLaneGroupKey(hostId, repositoryId)
  const [collapsed, setCollapsed] = useFolderCollapse(groupKey)
  useRemotePullRequests(hostId, repositoryId, !collapsed && available)
  const search = useRemoteGroupSearch(hostId, repositoryId, lanes)
  const ready = !!host && canReadHost(host) && host.state === 'ready'
  const canSelect =
    ready &&
    host.capabilities.includes('workspaces.write') &&
    host.capabilities.includes('sessions.control')
  const selection = useFolderSelection(hostId, groupKey, canSelect, search.visible)
  useLaneReveal(groupKey, () => {
    setCollapsed(false)
    search.clear()
  })
  const controlClass = headerControlClass(density)
  return (
    <section aria-label={name} className="min-w-0">
      <WorkspaceGroupHeader>
        <WorkspaceGroupTitle
          name={name}
          collapsed={collapsed}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {!ready && <LastKnown />}
        </WorkspaceGroupTitle>
        <SearchToggle
          name={name}
          search={search}
          className={controlClass}
          onOpen={() => setCollapsed(false)}
        />
        {available && (
          <RemoteWorkspaceOptions
            hostId={hostId}
            group={group}
            canSelect={canSelect}
            selecting={selection.selecting}
            collapsed={collapsed}
            className={controlClass}
            onCollapse={setCollapsed}
            onSelect={(mode) => {
              if (mode !== 'clear') setCollapsed(false)
              selection.select(mode)
            }}
          />
        )}
        {available && <NewLaneButton hostId={hostId} group={group} className={controlClass} />}
      </WorkspaceGroupHeader>
      {!available && (
        <p className="text-text-tertiary px-2 py-1 text-sm">
          Not in this Host’s current folders. Delete a lane from its menu.
        </p>
      )}
      {search.searching && <GroupSearchBar search={search} total={lanes.length} />}
      {!collapsed && (
        <GroupLanes
          hostId={hostId}
          lanes={search.visible}
          ready={ready}
          query={search.query}
          select={selection.rows}
        />
      )}
      <RemoteBulkDelete hostId={hostId} selectionKey={selection.key} lanes={lanes} />
    </section>
  )
}

/** The folder's collapse, in the sidebar's one collapsed-groups pref. Open until chosen. */
function useFolderCollapse(groupKey: string): [boolean, (collapsed: boolean) => void] {
  useEffect(ensureGroupCollapse, [])
  const collapsed = useGroupCollapse((s) => s.collapsed?.[groupKey] ?? false)
  return [collapsed, (next) => setGroupCollapsed(groupKey, next)]
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

function headerControlClass(density: RemoteLaneDensity): string {
  return clsx(
    'text-text-tertiary hover:text-text hover:bg-sidebar-hover flex shrink-0 items-center justify-center rounded-md transition-colors',
    density === 'page' ? 'h-7 w-7' : 'h-5 w-5',
  )
}

function GroupSearchBar({
  search,
  total,
}: {
  search: ReturnType<typeof useRemoteGroupSearch>
  total: number
}): React.JSX.Element {
  return (
    <LaneSearchBar
      value={search.draft}
      applied={!!search.query}
      matchCount={search.visible.length}
      total={total}
      onChange={search.setDraft}
      onCommit={search.commit}
      onClear={search.clear}
    />
  )
}

/** A Host that is not ready shows its folders as last known. */
function LastKnown(): React.JSX.Element {
  return (
    <span className="text-text-tertiary shrink-0 rounded bg-chip px-1 text-2xs font-normal normal-case tracking-normal">
      last known
    </span>
  )
}

/** The header's search button: opens the search bar, or closes and clears it. */
function SearchToggle({
  name,
  search,
  className,
  onOpen,
}: {
  name: string
  search: ReturnType<typeof useRemoteGroupSearch>
  className: string
  onOpen: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      className={className}
      aria-label={`Search lanes in ${name}`}
      aria-expanded={search.searching}
      title="Search lanes"
      onClick={() => {
        if (search.searching) search.clear()
        else {
          search.open()
          onOpen()
        }
      }}
    >
      <SearchIcon size={12} />
    </TooltipButton>
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
  const active = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId] : undefined,
  )
  const deleting = useSessionsStore((s) => s.bulkDelete?.running ?? false)
  return (
    <div className={!ready ? 'opacity-50' : undefined}>
      <SessionList
        disabled={!ready || !!query || !!select?.selecting || deleting}
        items={lanes.map((lane) => ({
          id: lane.laneId,
          path: remoteLaneOrderKey(hostId, lane.laneId),
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
              select={
                select && {
                  selected: select.selected.includes(lane.laneId),
                  selecting: select.selecting,
                  blocked: canDeleteRemoteLane(hostId, lane) ? undefined : TAKE_CONTROL_FIRST,
                  onToggle: (shiftKey) =>
                    toggleLane(select.group, select.order, lane.laneId, shiftKey),
                }
              }
            />
          ),
        }))}
      />
      {!lanes.length && (
        <p className="text-text-tertiary px-2 py-2 text-sm">
          {query ? `No lanes match “${query}”` : 'No lanes yet'}
        </p>
      )}
    </div>
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
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const ready = host?.state === 'ready'
  const canStart = ready && host.capabilities.includes('sessions.control')
  return (
    <TooltipButton
      className={className}
      aria-label={`New lane in ${group.name}`}
      title={!ready ? REMOTE_NOT_READY : !canStart ? REMOTE_UNAVAILABLE : 'New session here'}
      disabled={!canStart}
      onClick={() => {
        openRemoteComposer(hostId, group.repositoryId)
        navigate({ to: 'new', machine: hostId })
      }}
    >
      <PlusIcon size={12} strokeWidth={2.5} />
    </TooltipButton>
  )
}
