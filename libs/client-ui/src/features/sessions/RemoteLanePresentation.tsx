import { PrBadge } from './PrBadge'
import { useRemotePr } from './remotePullRequests'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import type { HostLaneView } from '@shared/ipc'
import { useId } from 'react'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { REMOTE_NOT_READY } from '@/stores/remoteLanes'
import { LaneRow, SessionIndicator, SubtitleSegments } from './SidebarPrimitives'
import { LaneMarker } from './LaneMarker'
import { PinIcon } from '@/components/icons'
import { remoteLanePresentation, remoteLaneTitle } from './remoteLaneView'

/** Read-only title projection: subscribed transcript metadata wins over a lagging Host scan. */
export function useRemoteLaneTitle(lane: HostLaneView, hostId?: string): string {
  const sessionId = useSessionsStore((s) =>
    hostId
      ? Object.values(s.live).find(
          (e) =>
            e.target?.kind === 'remote' && e.target.hostId === hostId && e.laneId === lane.laneId,
        )?.phosphorId
      : undefined,
  )
  const chat = useChatStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const first = chat?.items.find((item) => item.kind === 'user')
  return remoteLaneTitle(
    chat?.meta?.sessionName,
    lane.title,
    first?.kind === 'user' ? first.text : undefined,
  )
}

type RemoteLanePresentationProps = Omit<React.ComponentProps<typeof LaneRow>, 'children'> & {
  lane: HostLaneView
  hostId?: string
  title: string
  ready?: boolean
  active?: boolean
  pinned?: boolean
  /** The lane's folder, for rows that mix folders (the Pinned section). */
  workspaceName?: string
  marker?: React.ReactNode
}

/** The Host lane row's surface; `RemoteLaneRow` supplies its handlers, menu and marker. */
export function RemoteLanePresentation({
  lane,
  hostId,
  title,
  ready = true,
  active = false,
  pinned = false,
  workspaceName,
  marker,
  ...props
}: RemoteLanePresentationProps): React.JSX.Element {
  const { pr, confirmedNoPr } = useRemotePr(hostId, lane)
  const showPr = useLanePrefsStore((s) => s.lanes.prStatus)
  const description = useId()
  const view = remoteLanePresentation(lane, ready)
  const stateLabel = {
    streaming: '',
    unseen: 'Unread activity. ',
    live: 'Live session. ',
    disk: 'Stored session. ',
  }[view.indicator]
  const details = view.segments
    .map((segment) =>
      segment.key === 'worktree'
        ? 'worktree wt'
        : segment.key === 'branch'
          ? `branch ${segment.text}`
          : segment.text,
    )
    .join(' · ')
  return (
    <>
      <LaneRow
        disabled={!ready}
        tooltip={!ready ? REMOTE_NOT_READY : title}
        aria-label={title}
        aria-describedby={description}
        aria-current={active ? 'page' : undefined}
        data-testid="remote-session-row"
        data-activity={view.activity}
        className={active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}
        {...props}
      >
        <SessionIndicator state={view.indicator} />
        {marker ?? <LaneMarker marker="" />}
        <span className="min-w-0 flex-1">
          <span className="text-text block truncate text-lg font-medium leading-5">{title}</span>
          <span className="text-text-secondary flex items-center gap-1 text-base leading-4">
            <SubtitleSegments segments={view.segments} activity={view.activity} />
            {view.needsYou && <span className="text-warning shrink-0">needs you</span>}
            {showPr && (pr || confirmedNoPr) && <PrBadge pr={pr ?? null} />}
          </span>
        </span>
        {workspaceName && (
          <span
            data-testid="session-workspace-badge"
            className="bg-chip text-text-secondary shrink-0 rounded px-1.5 py-px text-2xs font-medium"
          >
            {workspaceName}
          </span>
        )}
        {pinned && (
          <span data-testid="lane-pin" className="shrink-0">
            <PinIcon className="text-text-tertiary" />
          </span>
        )}
      </LaneRow>
      <span id={description} className="sr-only">
        {pinned ? 'Pinned. ' : ''}
        {stateLabel}
        {view.activity === 'working' ? 'Working. ' : ''}
        {details}
        {view.needsYou ? ' · needs you' : ''}
      </span>
    </>
  )
}
