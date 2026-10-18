import { ContextMenuHost } from '@/components/ContextMenu'
import { CompactSignIn } from './CompactSignIn'
import { clearCompactUi, waitForCompactCleanup } from './compactLifecycle'
import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useState } from 'react'
import { PlatformProvider, COMPACT_PLATFORM } from '@/platform/Platform'
import { NavigationProvider, useNavigation } from '@/navigation/Navigation'
import { GlobalScreen, SCREENS } from '@/navigation/screens'
import { useAccount } from '@/features/settings/useAccount'
import { attachMachinesListener, useMachinesStore } from '@/stores/machines'
import { attachRemoteLanesListener, useRemoteLanesStore } from '@/stores/remoteLanes'
import { attachPiCommandsListener } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { loadBundledFonts } from '@/lib/fonts'
import { TooltipProvider } from '@/components/Tooltip'
import { PromptHost } from '@/components/PromptHost'
import { ExtensionDialogHost, ToastHost } from '@/features/extension-ui/ExtensionUiHosts'
import { Button } from '@/components/form'
import { useBrowserNavigation } from './useBrowserNavigation'
import { useCompactViewport } from './useCompactViewport'
import { CompactLanes } from './CompactLanes'
import { CompactLane } from './CompactLane'
import { CompactNew } from './CompactNew'
import { CompactSettings } from './CompactSettings'

/** Mount only after the real browser adapter has been installed and started. */
export function CompactApp(): React.JSX.Element {
  useCompactViewport()
  const account = useAccount()
  useEffect(() => {
    void loadBundledFonts()
    void useSettingsStore
      .getState()
      .hydrate()
      .catch(() => undefined)
  }, [])
  const signedIn = account.view?.account.status === 'signed-in'
  return (
    <PlatformProvider value={COMPACT_PLATFORM}>
      <TooltipProvider>
        {signedIn ? (
          <AuthenticatedCompact
            key={
              account.view?.account.status === 'signed-in'
                ? JSON.stringify([account.generation, account.view.account.user])
                : ''
            }
          />
        ) : (
          <CompactSignIn view={account.view} error={account.error} />
        )}
      </TooltipProvider>
    </PlatformProvider>
  )
}

function AuthenticatedCompact(): React.JSX.Element {
  const navigation = useBrowserNavigation()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    let detach: (() => void) | undefined
    void waitForCompactCleanup().then(() => {
      if (!active) return
      const offMachines = attachMachinesListener()
      const offLanes = attachRemoteLanesListener()
      const offCommands = attachPiCommandsListener()
      detach = () => {
        offCommands()
        offLanes()
        offMachines()
      }
      setReady(true)
    })
    return () => {
      active = false
      detach?.()
      clearCompactUi()
    }
  }, [])
  if (!ready)
    return (
      <main className="compact-shell compact-sign-in" role="status">
        Connecting to your machines…
      </main>
    )
  return (
    <NavigationProvider value={navigation}>
      <CompactShell pending={navigation.pending} />
      <ContextMenuHost />
      <ExtensionDialogHost />
      <PromptHost />
      <ToastHost />
    </NavigationProvider>
  )
}

function CompactShell({ pending }: { pending: boolean }): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading || !s.remoteEnabled)
  const directoryError = useMachinesStore((s) => s.error)
  const machine =
    location.to === 'lane' && 'hostId' in location.lane
      ? location.lane.hostId
      : 'machine' in location
        ? location.machine
        : undefined
  const missing =
    !!machine && !loading && !directoryError && !machines.some((m) => m.id === machine)
  const laneTitle = useRemoteLanesStore((s) =>
    location.to === 'lane' && 'hostId' in location.lane
      ? s.hosts[location.lane.hostId]?.lanes.find(
          (lane) => 'laneId' in location.lane && lane.laneId === location.lane.laneId,
        )?.title
      : undefined,
  )
  const title =
    location.to === 'page'
      ? SCREENS[location.page].title
      : location.to === 'lane'
        ? laneTitle || 'Lane'
        : location.to === 'inbox'
          ? 'Inbox'
          : 'Phosphor'
  const needsMachine =
    location.to === 'new' ||
    (location.to === 'page' && ['skills', 'routines'].includes(location.page))
  return (
    <div className="compact-shell" data-testid="compact-shell">
      <header className="compact-header">
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
            const machine = event.target.value || undefined
            navigate(
              location.to === 'lane' || location.to === 'unavailable'
                ? { to: 'lanes', machine }
                : { ...location, machine },
            )
          }}
        >
          <option value="">All machines</option>
          {missing && <option value={machine}>Unavailable machine</option>}
          {machines.map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.label}
            </option>
          ))}
        </select>
      </header>
      <main className="compact-main">
        {missing ? (
          <p role="alert" className="p-4">
            This machine is no longer in your account.
          </p>
        ) : pending ? (
          <p role="status" className="p-4">
            Opening…
          </p>
        ) : needsMachine && !machine ? (
          <p className="p-4">Choose a machine above to continue.</p>
        ) : location.to === 'lane' ? (
          <CompactLane
            key={
              'hostId' in location.lane
                ? `${location.lane.hostId}:${location.lane.laneId}`
                : location.lane.sessionId
            }
            location={location}
            navigate={navigate}
          />
        ) : location.to === 'new' ? (
          <CompactNew key={machine} hostId={machine!} />
        ) : location.to === 'page' ? (
          location.page === 'settings' ? (
            <CompactSettings machine={machine} />
          ) : (
            <GlobalScreen
              page={location.page}
              workspacePath={machine ? `host:${machine}/machine` : ''}
            />
          )
        ) : location.to === 'unavailable' ? (
          <p role="alert" className="p-4">
            This link is unavailable. Open Lanes or Machines to continue.
          </p>
        ) : (
          <CompactLanes machine={machine} inbox={location.to === 'inbox'} />
        )}
      </main>
      <nav className="compact-tabs" aria-label="Main navigation">
        {(['lanes', 'inbox', 'new'] as const).map((to) => (
          <TooltipButton
            key={to}
            aria-current={location.to === to ? 'page' : undefined}
            onClick={() => navigate({ to, machine })}
          >
            <NavIcon screen={to} />
            {SCREENS[to].title}
          </TooltipButton>
        ))}
        <TooltipButton
          aria-current={location.to === 'page' && location.page === 'machines' ? 'page' : undefined}
          onClick={() => navigate({ to: 'page', page: 'machines' })}
        >
          <NavIcon screen="machines" />
          Machines
        </TooltipButton>
        <TooltipButton
          aria-current={location.to === 'page' && location.page === 'settings' ? 'page' : undefined}
          onClick={() => navigate({ to: 'page', page: 'settings', machine })}
        >
          <NavIcon screen="settings" />
          More
        </TooltipButton>
      </nav>
    </div>
  )
}

function NavIcon({
  screen,
}: {
  screen: 'lanes' | 'inbox' | 'new' | 'machines' | 'settings'
}): React.JSX.Element {
  const Icon = SCREENS[screen].icon
  return (
    <span aria-hidden="true">
      <Icon size={19} />
    </span>
  )
}
