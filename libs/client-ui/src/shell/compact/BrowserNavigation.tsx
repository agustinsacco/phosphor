import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { CloseIcon } from '@/components/icons'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { NavigationItem } from '@/navigation/NavigationItem'
import { PageLinks } from '@/navigation/PageLinks'
import { useNavigation } from '@/navigation/Navigation'
import { SCREENS } from '@/navigation/screens'
import type { Location } from '@/navigation/location'

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
  const go = (next: Location): void => {
    onClose()
    navigate(next)
  }
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
      <nav aria-label="Main navigation" className="browser-navigation-links">
        {(['new', 'lanes', 'inbox'] as const).map((to) => {
          const { icon: Icon, title } = SCREENS[to]
          return (
            <NavigationItem
              key={to}
              label={title}
              icon={<Icon />}
              active={location.to === to}
              onClick={() => go({ to, machine })}
            />
          )
        })}
        <PageLinks
          activePage={location.to === 'page' ? location.page : null}
          onPage={(page) =>
            go({ to: 'page', page, machine: page === 'machines' ? undefined : machine })
          }
        />
        <NavigationItem
          label="Settings"
          icon={<SCREENS.settings.icon />}
          active={location.to === 'page' && location.page === 'settings'}
          onClick={() => go({ to: 'page', page: 'settings', machine })}
        />
      </nav>
      <p className="browser-navigation-note">Connected directly to your machines.</p>
    </>
  )
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
