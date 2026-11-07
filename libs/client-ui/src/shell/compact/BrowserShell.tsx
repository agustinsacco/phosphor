import { Button } from '@/components/form'
import { WaitingNote, WaitingPane } from '@/components/Waiting'
import { useNavigation } from '@/navigation/Navigation'
import { GlobalScreen } from '@/navigation/screens'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { usePlatform } from '@/platform/Platform'
import { locationMachine } from '@/navigation/location'
import { LaneLocation } from '@/features/machines/LaneLocation'
import { RemoteLaneLinks } from '@/features/sessions/LaneLinks'
import { BrowserNavigation } from './BrowserNavigation'
import { CompactLane } from './CompactLane'
import { CompactLaneHeader } from './CompactLaneHeader'
import { CompactHome } from './CompactHome'
import { CompactLanes } from './CompactLanes'
import { CompactNew } from './CompactNew'
import { CompactSettings } from './CompactSettings'
import { BottomTabs } from './BottomTabs'
import { isLibraryPage, useBrowserMemory } from './browserMemory'
import { LibrarySwitcher } from './LibrarySwitcher'
import { NewLaneAction } from './NewLaneAction'
import { useRememberWhere } from './useBrowserScope'

export function BrowserShell({ pending }: { pending: boolean }): React.JSX.Element {
  const { location } = useNavigation()
  const compact = usePlatform().formFactor === 'compact'
  const machine = locationMachine(location)
  useRememberWhere(location)
  // A phone's lane and start page own the bottom of the screen: the composer is there.
  const tabs = compact && location.to !== 'lane' && location.to !== 'new'
  return (
    <div className="compact-shell browser-shell" data-testid="compact-shell">
      {!compact && <BrowserNavigation machine={machine} />}
      <div className="browser-content">
        {compact && location.to === 'lane' ? (
          <CompactLaneHeader location={location} />
        ) : (
          (!compact || location.to === 'new') && <BrowserHeader machine={machine} />
        )}
        <main className="compact-main" data-route={location.to} data-tabs={tabs || undefined}>
          <BrowserScreen machine={machine} pending={pending} />
        </main>
        {tabs && <NewLaneAction floating />}
        {tabs && <BottomTabs />}
      </div>
    </div>
  )
}

/** A wide browser's top bar; on a phone, the start page's way back to its lanes. */
function BrowserHeader({ machine }: { machine?: string }): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const compact = usePlatform().formFactor === 'compact'
  const lanes = useBrowserMemory((s) => s.lanes)
  const title = useRemoteLanesStore((s) =>
    location.to === 'lane' && 'hostId' in location.lane
      ? s.hosts[location.lane.hostId]?.lanes.find(
          (lane) => 'laneId' in location.lane && lane.laneId === location.lane.laneId,
        )?.title || 'Lane'
      : compact && location.to === 'new'
        ? 'New lane'
        : 'Phosphor',
  )
  const back = compact ? (lanes ?? { to: 'lanes' as const }) : { to: 'lanes' as const, machine }
  return (
    <header className="compact-header">
      {(location.to === 'lane' || compact) && (
        <Button aria-label="Back to lanes" onClick={() => navigate(back)}>
          ←
        </Button>
      )}
      <strong>{title}</strong>
      {location.to === 'lane' && 'laneId' in location.lane && (
        <RemoteLaneLinks hostId={location.lane.hostId} laneId={location.lane.laneId} />
      )}
      {location.to === 'lane' && 'laneId' in location.lane && (
        <LaneLocation hostId={location.lane.hostId} laneId={location.lane.laneId} />
      )}
      {!compact && <NewLaneAction />}
    </header>
  )
}

function BrowserScreen({
  machine,
  pending,
}: {
  machine?: string
  pending: boolean
}): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const compact = usePlatform().formFactor === 'compact'
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading || !s.remoteEnabled)
  const error = useMachinesStore((s) => s.error)
  if (machine && !loading && !error && !machines.some((item) => item.id === machine))
    return (
      <p role="alert" className="p-4">
        This machine is no longer in your account.
      </p>
    )
  if (pending) return <WaitingPane title="Opening…" />
  if (location.to === 'lane')
    return (
      <CompactLane
        key={
          'hostId' in location.lane
            ? `${location.lane.hostId}:${location.lane.laneId}`
            : location.lane.sessionId
        }
        location={location}
        navigate={navigate}
      />
    )
  if (location.to === 'new')
    return machine ? <CompactNew key={machine} hostId={machine} /> : <ChooseMachine />
  if (location.to === 'page') {
    if (location.page === 'settings') return <CompactSettings machine={machine} />
    if (!machine && ['skills', 'routines'].includes(location.page)) return <ChooseMachine />
    const screen = (
      <GlobalScreen page={location.page} workspacePath={machine ? `host:${machine}/machine` : ''} />
    )
    return compact && isLibraryPage(location.page) ? (
      <div className="library-screen">
        <LibrarySwitcher page={location.page} machine={machine} />
        {screen}
      </div>
    ) : (
      screen
    )
  }
  if (location.to === 'unavailable')
    return (
      <p role="alert" className="p-4">
        This link is unavailable. Open Lanes or Machines to continue.
      </p>
    )
  return machine ? <CompactLanes machine={machine} /> : <CompactHome />
}

/**
 * A screen that needs a machine before one is pinned: `useDefaultMachine` pins the scoped
 * machine as soon as the list loads, so this only stays while loading or with no machines.
 */
function ChooseMachine(): React.JSX.Element {
  const { navigate } = useNavigation()
  const loading = useMachinesStore((s) => s.loading)
  return (
    <section className="compact-list browser-empty" aria-label="Choose a machine">
      <h1>Your workspace, wherever you are.</h1>
      {loading ? (
        <WaitingNote>Checking your machines…</WaitingNote>
      ) : (
        <p>No machines yet. Add a Host from Machines.</p>
      )}
      <Button onClick={() => navigate({ to: 'page', page: 'machines' })}>Machines</Button>
    </section>
  )
}
