import { useState } from 'react'
import { Button } from '@/components/form'
import { PlusIcon, SidebarToggleIcon } from '@/components/icons'
import { useNavigation } from '@/navigation/Navigation'
import { GlobalScreen } from '@/navigation/screens'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { usePlatform } from '@/platform/Platform'
import { locationMachine } from '@/navigation/location'
import { BrowserNavigation } from './BrowserNavigation'
import { CompactLane } from './CompactLane'
import { CompactLanes } from './CompactLanes'
import { CompactNew } from './CompactNew'
import { CompactSettings } from './CompactSettings'

export function BrowserShell({ pending }: { pending: boolean }): React.JSX.Element {
  const { location } = useNavigation()
  const compact = usePlatform().formFactor === 'compact'
  const [drawer, setDrawer] = useState(false)
  const machine = locationMachine(location)
  return (
    <div className="compact-shell browser-shell" data-testid="compact-shell">
      {!compact && <BrowserNavigation machine={machine} onClose={() => setDrawer(false)} />}
      <div className="browser-content" inert={compact && drawer ? true : undefined}>
        <BrowserHeader machine={machine} onMenu={() => setDrawer(true)} />
        <main className="compact-main">
          <BrowserScreen machine={machine} pending={pending} />
        </main>
      </div>
      {compact && drawer && (
        <BrowserNavigation drawer machine={machine} onClose={() => setDrawer(false)} />
      )}
    </div>
  )
}

function BrowserHeader({
  machine,
  onMenu,
}: {
  machine?: string
  onMenu: () => void
}): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const compact = usePlatform().formFactor === 'compact'
  const machines = useMachinesStore((s) => s.machines)
  const title = useRemoteLanesStore((s) =>
    location.to === 'lane' && 'hostId' in location.lane
      ? s.hosts[location.lane.hostId]?.lanes.find(
          (lane) => 'laneId' in location.lane && lane.laneId === location.lane.laneId,
        )?.title || 'Lane'
      : 'Phosphor',
  )
  return (
    <header className="compact-header">
      {compact && (
        <Button aria-label="Open navigation" onClick={onMenu}>
          <SidebarToggleIcon size={18} />
        </Button>
      )}
      {location.to === 'lane' && (
        <Button aria-label="Back to lanes" onClick={() => navigate({ to: 'lanes', machine })}>
          ←
        </Button>
      )}
      <strong>{title}</strong>
      <select
        aria-label="Machine filter"
        value={machine ?? ''}
        onChange={(event) => {
          const selected = event.target.value || undefined
          navigate(
            location.to === 'lane' || location.to === 'unavailable'
              ? { to: 'lanes', machine: selected }
              : { ...location, machine: selected },
          )
        }}
      >
        <option value="">All machines</option>
        {machine && !machines.some((item) => item.id === machine) && (
          <option value={machine}>Unavailable machine</option>
        )}
        {machines.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
      <Button aria-label="New lane" onClick={() => navigate({ to: 'new', machine })}>
        <PlusIcon size={17} />
      </Button>
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
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading || !s.remoteEnabled)
  const error = useMachinesStore((s) => s.error)
  if (machine && !loading && !error && !machines.some((item) => item.id === machine))
    return (
      <p role="alert" className="p-4">
        This machine is no longer in your account.
      </p>
    )
  if (pending)
    return (
      <p role="status" className="p-4">
        Opening…
      </p>
    )
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
    return (
      <GlobalScreen page={location.page} workspacePath={machine ? `host:${machine}/machine` : ''} />
    )
  }
  if (location.to === 'unavailable')
    return (
      <p role="alert" className="p-4">
        This link is unavailable. Open Lanes or Machines to continue.
      </p>
    )
  return <CompactLanes machine={machine} inbox={location.to === 'inbox'} />
}

function ChooseMachine(): React.JSX.Element {
  const { navigate } = useNavigation()
  const loading = useMachinesStore((s) => s.loading)
  const machines = useMachinesStore((s) => s.machines)
  return (
    <section className="compact-list browser-empty" aria-label="Choose a machine">
      <h1>Your workspace, wherever you are.</h1>
      <p>
        {loading
          ? 'Checking your machines…'
          : machines.length
            ? 'Choose a machine above to continue.'
            : 'No machines yet. Add a Host from Machines.'}
      </p>
      <Button onClick={() => navigate({ to: 'page', page: 'machines' })}>Machines</Button>
    </section>
  )
}
