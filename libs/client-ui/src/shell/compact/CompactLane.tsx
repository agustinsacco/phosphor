import { useLayoutStore } from '@/stores/layout'
import { TooltipButton } from '@/components/Tooltip'
import { lazy, Suspense, useLayoutEffect, useMemo } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { releaseHostLaneNav, useHostLaneOpenInFlight } from '@/stores/hostLaneOpen'
import { WaitingPane } from '@/components/Waiting'
import {
  connectingTo,
  hostReconnecting,
  openRemoteLane,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'
import { ChatView } from '@/features/chat/ChatView'
import { requestChatFind } from '@/features/chat/useChatFind'
import { SessionMenu } from '@/features/chat/SessionMenu'
import { LaneChangesPane } from '@/features/files/LaneChangesPane'
import { SCREENS } from '@/navigation/screens'
import { usePlatform } from '@/platform/Platform'
import { laneTarget, useTerminalRefusal } from '@/stores/terminal'
import { COMPACT_LANE_PANES } from './CompactLaneHeader'
import { useRemoteLaneSession } from '@/features/sessions/useRemoteLaneActions'
import { OpeningLane } from '@/features/sessions/OpeningLane'
import { remoteLaneTitle } from '@/features/sessions/remoteLaneView'
import type { Location } from '@/navigation/location'
const TerminalPane = lazy(() =>
  import('@/features/terminal/TerminalPane').then((m) => ({ default: m.TerminalPane })),
)
// Files loads its explorer and editor on use; Monaco itself loads only where it runs.
const LaneFilesPane = lazy(() =>
  import('@/features/files/LaneFilesPane').then((m) => ({ default: m.LaneFilesPane })),
)
const SubagentPanel = lazy(() =>
  import('@/features/chat/SubagentPanel').then((m) => ({ default: m.SubagentPanel })),
)
const ArtifactsPane = lazy(() =>
  import('@/features/artifacts/RemoteArtifactsPane').then((m) => ({
    default: m.RemoteArtifactsPane,
  })),
)

function useOpenRoutedLane(hostId: string, laneId: string, ready: boolean): void {
  // Before paint, so the first frame already shows the open it starts.
  useLayoutEffect(() => {
    if (!ready) return
    const { navSeq, opening } = useSessionsStore.getState()
    // A notice or Continue can put its own open in the URL. Don't replace its claim.
    if (opening?.lane?.hostId === hostId && opening.lane.laneId === laneId) return
    void openRemoteLane(hostId, laneId)
    const nav = useSessionsStore.getState().navSeq
    if (nav !== navSeq) return () => releaseHostLaneNav(nav)
  }, [hostId, laneId, ready])
}

export function CompactLane({
  location,
  navigate,
}: {
  location: Extract<Location, { to: 'lane' }>
  navigate: (next: Location) => void
}): React.JSX.Element {
  const key = location.lane
  const hostId = 'hostId' in key ? key.hostId : ''
  const laneId = 'laneId' in key ? key.laneId : ''
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const snapshotStatus = useRemoteLanesStore((s) => s.snapshotStatus)
  const lane = host?.lanes.find((lane) => lane.laneId === laneId)
  const session = useRemoteLaneSession(hostId, laneId)
  // The open's state is the store's, so the browser shows what Desktop shows.
  const opening = useSessionsStore((s) =>
    s.opening?.lane?.hostId === hostId && s.opening.lane.laneId === laneId ? s.opening : null,
  )
  const filter = useRemoteLanesStore((s) => s.filter)
  const page = useLayoutStore((s) => s.page)
  const navigationReady = filter === hostId && page === null
  const ready = host?.state === 'ready' && !!lane
  const inFlight = useHostLaneOpenInFlight(hostId, laneId)
  useOpenRoutedLane(hostId, laneId, ready && navigationReady)
  if (snapshotStatus === 'idle' || snapshotStatus === 'loading')
    return <WaitingPane title="Connecting to your machines…" />
  if (snapshotStatus === 'error')
    return (
      <p role="alert" className="p-4">
        Could not read Host connections. Reconnect from Machines.
      </p>
    )
  if (!host || (host.state === 'ready' && !lane))
    return (
      <p role="alert" className="p-4">
        This Host or lane is unavailable. It may have been removed.
      </p>
    )
  // A lane already on screen stays there while its Host retries: a phone that
  // slept reconnects every time it wakes, and swapping the lane out lost its place.
  const reconnecting = hostReconnecting(host.state)
  if (reconnecting && !(lane && session))
    return (
      <WaitingPane
        title={connectingTo(hostId, host.state)}
        detail="This lane opens when it answers."
      />
    )
  if (!ready && !reconnecting)
    return (
      <p role="status" className="p-4">
        Machine not connected. Open Machines to reconnect.
      </p>
    )
  if (opening || !session || !navigationReady)
    return (
      <div className="relative h-full">
        <OpeningLane
          lane={
            opening ?? {
              title: remoteLaneTitle(undefined, lane?.title),
              reason: 'open',
              lane: { hostId, laneId },
              // Nothing is opening it: say so with Retry rather than spin forever.
              ...(navigationReady && !inFlight ? { failure: 'This lane did not open.' } : {}),
            }
          }
        />
      </div>
    )
  return <LanePanes location={location} navigate={navigate} session={session} />
}

function LanePanes({
  location,
  navigate,
  session,
}: {
  location: Extract<Location, { to: 'lane' }>
  navigate: (next: Location) => void
  session: { phosphorId: string; workspacePath: string }
}): React.JSX.Element {
  const pane = location.pane ?? 'chat'
  // A phone switches panes from the lane menu in its header (CompactLaneHeader), which
  // also carries the lane's controls; wider browsers keep tabs and Desktop's control row.
  const tabs = usePlatform().formFactor !== 'compact'
  const terminalRefusal = useTerminalRefusal(session.phosphorId)
  const terminalTarget = useMemo(
    () => laneTarget(session.phosphorId, session.workspacePath),
    [session.phosphorId, session.workspacePath],
  )
  return (
    <div className="flex h-full min-h-0 flex-col">
      {tabs && (
        <nav className="compact-lane-tabs" aria-label="Lane panes">
          {COMPACT_LANE_PANES.map((id) => (
            <TooltipButton
              key={id}
              aria-current={pane === id ? 'page' : undefined}
              onClick={() => navigate({ ...location, pane: id })}
            >
              {SCREENS[id].title}
            </TooltipButton>
          ))}
          <SessionMenu
            sessionId={session.phosphorId}
            className="compact-lane-options"
            onFind={() => {
              requestChatFind(session.phosphorId)
              navigate({ ...location, pane: 'chat' })
            }}
          />
        </nav>
      )}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <p role="status" className="p-4">
              Loading…
            </p>
          }
        >
          {pane === 'chat' ? (
            <ChatView
              key={session.phosphorId}
              sessionId={session.phosphorId}
              workspacePath={session.workspacePath}
              laneControls={tabs ? 'row' : 'header'}
            />
          ) : pane === 'files' ? (
            <LaneFilesPane
              key={session.phosphorId}
              sessionId={session.phosphorId}
              workspacePath={session.workspacePath}
            />
          ) : pane === 'changes' ? (
            <LaneChangesPane key={session.phosphorId} sessionId={session.phosphorId} />
          ) : pane === 'artifacts' ? (
            <ArtifactsPane sessionId={session.phosphorId} workspacePath={session.workspacePath} />
          ) : pane === 'subagents' ? (
            <SubagentPanel sessionId={session.phosphorId} />
          ) : pane === 'terminal' && !terminalRefusal ? (
            <TerminalPane target={terminalTarget} />
          ) : pane === 'terminal' ? (
            <p className="p-4">{terminalRefusal}</p>
          ) : (
            <p className="p-4">This pane is unavailable.</p>
          )}
        </Suspense>
      </div>
    </div>
  )
}
