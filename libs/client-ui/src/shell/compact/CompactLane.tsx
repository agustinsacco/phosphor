import { useLayoutStore } from '@/stores/layout'
import { TooltipButton } from '@/components/Tooltip'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import {
  hostReconnecting,
  machineLabel,
  openRemoteLane,
  useRemoteLanesStore,
} from '@/stores/remoteLanes'
import { ChatView } from '@/features/chat/ChatView'
import { ReadOnlyFilesPane } from '@/features/files/ReadOnlyFilesPane'
import { SCREENS } from '@/navigation/screens'
import type { Location } from '@/navigation/location'
const ArtifactsPane = lazy(() =>
  import('@/features/artifacts/RemoteArtifactsPane').then((m) => ({
    default: m.RemoteArtifactsPane,
  })),
)

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
  const session = useSessionsStore((s) =>
    Object.values(s.live).find(
      (entry) =>
        entry.target?.kind === 'remote' &&
        entry.target.hostId === hostId &&
        entry.laneId === laneId,
    ),
  )
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const filter = useRemoteLanesStore((s) => s.filter)
  const page = useLayoutStore((s) => s.page)
  const navigationReady = filter === hostId && page === null
  const ready = host?.state === 'ready' && !!lane
  useEffect(() => {
    let current = true
    setFailed(false)
    if (ready && navigationReady)
      void openRemoteLane(hostId, laneId).then((ok) => {
        if (current) setFailed(!ok)
      })
    return () => {
      current = false
      useSessionsStore.getState().claimNav()
    }
  }, [hostId, laneId, ready, navigationReady, attempt])
  if (snapshotStatus === 'idle' || snapshotStatus === 'loading')
    return (
      <p role="status" className="p-4">
        Connecting to machines…
      </p>
    )
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
  if (!ready && !(reconnecting && lane && session))
    return (
      <p role="status" className="p-4">
        {reconnecting
          ? `Reconnecting to ${machineLabel(hostId)}…`
          : 'Machine not connected. Open Machines to reconnect.'}
      </p>
    )
  if (failed)
    return (
      <div role="alert" className="p-4">
        Could not open this lane.{' '}
        <TooltipButton onClick={() => setAttempt((n) => n + 1)}>Retry</TooltipButton>
      </div>
    )
  if (!session || !navigationReady)
    return (
      <p role="status" className="p-4">
        Opening lane…
      </p>
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
  const placement = SCREENS[pane].compact
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="compact-lane-tabs" aria-label="Lane panes">
        {(['chat', 'files', 'changes', 'artifacts'] as const).map((id) => (
          <TooltipButton
            key={id}
            aria-current={pane === id ? 'page' : undefined}
            onClick={() => navigate({ ...location, pane: id })}
          >
            {SCREENS[id].title}
          </TooltipButton>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <p role="status" className="p-4">
              Loading…
            </p>
          }
        >
          {typeof placement === 'object' ? (
            <p className="p-4">{placement.notYet}</p>
          ) : pane === 'chat' ? (
            <ChatView
              key={session.phosphorId}
              sessionId={session.phosphorId}
              workspacePath={session.workspacePath}
            />
          ) : pane === 'files' || pane === 'changes' ? (
            <ReadOnlyFilesPane
              key={`${session.phosphorId}:${pane}`}
              sessionId={session.phosphorId}
              changes={pane === 'changes'}
            />
          ) : pane === 'artifacts' ? (
            <ArtifactsPane sessionId={session.phosphorId} workspacePath={session.workspacePath} />
          ) : (
            <p className="p-4">This pane is unavailable.</p>
          )}
        </Suspense>
      </div>
    </div>
  )
}
