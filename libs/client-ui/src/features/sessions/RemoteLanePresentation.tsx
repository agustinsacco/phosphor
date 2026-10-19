import type { HostLaneView } from '@shared/ipc'
import { useId } from 'react'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { REMOTE_NOT_READY } from '@/stores/remoteLanes'
import { LaneRow, SessionIndicator, SubtitleSegments } from './SidebarPrimitives'
import { LaneMarker } from './LaneMarker'
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
  title: string
  ready?: boolean
  active?: boolean
  pinned?: boolean
  marker?: React.ReactNode
}

/** Shared row surface; curation supplies its own handlers/marker, browser supplies only navigation. */
export function RemoteLanePresentation({
  lane,
  title,
  ready = true,
  active = false,
  pinned = false,
  marker,
  ...props
}: RemoteLanePresentationProps): React.JSX.Element {
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
          <span className="text-text block truncate text-lg font-medium leading-5">
            {pinned ? '⌖ ' : ''}
            {title}
          </span>
          <span className="text-text-secondary flex items-center gap-1 text-base leading-4">
            <SubtitleSegments segments={view.segments} activity={view.activity} />
            {view.needsYou && <span className="text-warning shrink-0">needs you</span>}
          </span>
        </span>
      </LaneRow>
      <span id={description} className="sr-only">
        {stateLabel}
        {view.activity === 'working' ? 'Working. ' : ''}
        {details}
        {view.needsYou ? ' · needs you' : ''}
      </span>
    </>
  )
}
