import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { InstallApp } from './InstallApp'
import { CloseIcon } from '@/components/icons'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { NavigationProvider, useNavigation, type Navigation } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { usePlatform } from '@/platform/Platform'
import { RemoteLanes } from '@/features/sessions/RemoteLanes'
import { SidebarFooter, SidebarNavigation } from '@/features/sessions/SidebarNavigation'

export function BrowserNavigation({
  machine,
  drawer = false,
  onClose,
}: {
  machine?: string
  drawer?: boolean
  onClose: () => void
}): React.JSX.Element {
  const body = <NavigationBody machine={machine} onClose={onClose} drawer={drawer} />
  return drawer ? (
    <NavigationDrawer onClose={onClose}>{body}</NavigationDrawer>
  ) : (
    <aside className="browser-navigation">{body}</aside>
  )
}

function NavigationBody({
  machine,
  drawer,
  onClose,
}: {
  machine?: string
  drawer: boolean
  onClose: () => void
}): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const { installableApp } = usePlatform()
  // Anything opened from here (a page, a lane, New, Settings) closes the phone drawer;
  // choosing a machine scope uses the outer navigation and keeps it open.
  const closing: Navigation = {
    location,
    navigate: (next) => {
      onClose()
      navigate(next)
    },
  }
  const go = closing.navigate
  return (
    <>
      <div className="browser-brand">
        <PhosphorLoader size={26} decorative animated={false} />
        <strong>Phosphor</strong>
        {drawer && (
          <Button aria-label="Close navigation" onClick={onClose}>
            <CloseIcon size={16} />
          </Button>
        )}
      </div>
      <NavigationProvider value={closing}>
        <SidebarNavigation
          onPage={(page) =>
            go({ to: 'page', page, machine: page === 'machines' ? undefined : machine })
          }
          onScope={(scope) => navigate(scopedLocation(location, scope))}
        />
        <div data-session-scroll className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <RemoteLanes />
        </div>
        <SidebarFooter />
      </NavigationProvider>
      {installableApp && (
        <div className="browser-install-nav">
          <InstallApp />
        </div>
      )}
      <p className="browser-navigation-note">Connected directly to your machines.</p>
    </>
  )
}

/** The browser keeps the machine scope in the URL; a lane or dead link falls back to its list. */
function scopedLocation(location: Location, scope: string): Location {
  const machine = scope === 'all' ? undefined : scope
  return location.to === 'lane' || location.to === 'unavailable'
    ? { to: 'lanes', machine }
    : { ...location, machine }
}

function NavigationDrawer({
  onClose,
  children,
}: {
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const trap = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const targets = ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    if (!targets?.length) return
    const target = event.shiftKey ? targets[targets.length - 1] : targets[0]
    const edge = event.shiftKey ? targets[0] : targets[targets.length - 1]
    if (document.activeElement === edge) {
      event.preventDefault()
      target?.focus()
    }
  }
  return (
    <ModalOverlay onClose={onClose} className="browser-drawer-overlay" backdrop="dim">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="browser-drawer"
        onKeyDown={trap}
      >
        {children}
      </div>
    </ModalOverlay>
  )
}
