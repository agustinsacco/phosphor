import { useState } from 'react'
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
import { RemoteBulkDelete } from './RemoteBulkDelete'
import { RemoteWorkspaceOptions } from './RemoteWorkspaceOptions'
import { RemoteLaneRow } from './RemoteLaneRow'
import { useRemotePullRequests } from './remotePullRequests'
import type { RemoteLaneGroup } from './groupRemoteLanes'
import { remoteLaneGroupKey, useLaneReveal } from './laneReveal'
import { LaneSearchBar } from './LaneSearchBar'
import { laneMatches, laneQueryTerms } from './laneSearch'
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
  const { repositoryId, name, available, lanes } = group
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [collapsed, setCollapsed] = useState(false)
  useRemotePullRequests(hostId, repositoryId, !collapsed && available)
  const search = useGroupSearch(lanes)
  const [selection, setSelection] = useState<'all' | 'merged' | null>(null)
  const ready = !!host && canReadHost(host) && host.state === 'ready'
  useLaneReveal(remoteLaneGroupKey(hostId, repositoryId), () => {
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
            host={host}
            ready={ready}
            collapsed={collapsed}
            className={controlClass}
            onCollapse={setCollapsed}
            onSelect={setSelection}
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
          selection={selection}
          onSelectionClose={() => setSelection(null)}
        />
      )}
    </section>
  )
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
  search: ReturnType<typeof useGroupSearch>
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
  search: ReturnType<typeof useGroupSearch>
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

/** A group's lane search: the draft being typed, the applied query and the lanes it keeps. */
function useGroupSearch(lanes: HostLaneView[]) {
  const [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const terms = laneQueryTerms(query)
  return {
    searching,
    draft,
    query,
    visible: lanes.filter((lane) =>
      laneMatches(`${lane.title ?? ''} ${lane.branch ?? ''}`.toLowerCase(), terms),
    ),
    setDraft,
    open: () => setSearching(true),
    commit: () => setQuery(draft),
    clear: () => {
      setSearching(false)
      setDraft('')
      setQuery('')
    },
  }
}

/** The group's rows, or its bulk-delete selection over the lanes the search shows. */
function GroupLanes({
  hostId,
  lanes,
  ready,
  query,
  selection,
  onSelectionClose,
}: {
  hostId: string
  lanes: HostLaneView[]
  ready: boolean
  query: string
  selection: 'all' | 'merged' | null
  onSelectionClose: () => void
}): React.JSX.Element {
  const active = useSessionsStore((s) =>
    s.activeSessionId ? s.live[s.activeSessionId] : undefined,
  )
  return (
    <div className={!ready ? 'opacity-50' : undefined}>
      {selection ? (
        <RemoteBulkDelete
          key={selection}
          hostId={hostId}
          lanes={lanes}
          mode={selection}
          onClose={onSelectionClose}
        />
      ) : (
        lanes.map((lane) => (
          <RemoteLaneRow
            key={lane.laneId}
            hostId={hostId}
            lane={lane}
            ready={ready}
            active={
              active?.target?.kind === 'remote' &&
              active.target.hostId === hostId &&
              active.laneId === lane.laneId
            }
          />
        ))
      )}
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
