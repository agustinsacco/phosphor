import type { ComponentType } from 'react'
import { HomeIcon, LibraryIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { useBoardLanes } from '@/features/home/useBoardLanes'
import { useNavigation } from '@/navigation/Navigation'
import { locationMachine, type Location } from '@/navigation/location'
import { SCREENS } from '@/navigation/screens'
import { isLibraryPage, useBrowserMemory } from './browserMemory'
import { useScopedMachine } from './useBrowserScope'

interface Tab {
  label: string
  icon: ComponentType<{ size?: number; className?: string }>
  active: (location: Location) => boolean
}

const onPage = (location: Location, page: string): boolean =>
  location.to === 'page' && location.page === page

const TABS = {
  home: { label: 'Home', icon: HomeIcon, active: (l) => l.to === 'lanes' },
  machines: {
    ...SCREENS.machines,
    label: SCREENS.machines.title,
    active: (l) => onPage(l, 'machines'),
  },
  library: {
    label: 'Library',
    icon: LibraryIcon,
    active: (l) => l.to === 'page' && isLibraryPage(l.page),
  },
  settings: {
    ...SCREENS.settings,
    label: SCREENS.settings.title,
    active: (l) => onPage(l, 'settings'),
  },
} satisfies Record<string, Tab>

/** Lanes waiting on you anywhere: the Home tab's badge. */
function useNeedsYouCount(): number {
  return useBoardLanes().filter((lane) => lane.urgency === 'needs-you').length
}

/**
 * The phone's top level, in thumb reach: Home (every machine's lanes), Machines, the
 * Library (Skills, Routines, Artifacts) and Settings. A tab returns to where you were in
 * it; tapping the tab you are on returns to its root.
 */
export function BottomTabs(): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const memory = useBrowserMemory()
  const scoped = useScopedMachine()
  const needsYou = useNeedsYouCount()
  const targets: Record<keyof typeof TABS, Location> = {
    home: TABS.home.active(location) ? { to: 'lanes' } : (memory.lanes ?? { to: 'lanes' }),
    machines: { to: 'page', page: 'machines' },
    library: {
      to: 'page',
      page: memory.library,
      ...(scoped && memory.library !== 'artifacts' ? { machine: scoped } : {}),
    },
    settings: {
      to: 'page',
      page: 'settings',
      ...(locationMachine(location) ? { machine: locationMachine(location) } : {}),
    },
  }
  return (
    <nav aria-label="Tabs" className="browser-tabs">
      {(Object.keys(TABS) as (keyof typeof TABS)[]).map((key) => {
        const { label, icon: Icon, active } = TABS[key]
        const current = active(location)
        return (
          <TooltipButton
            key={key}
            tooltip={false}
            className="browser-tab"
            aria-current={current ? 'page' : undefined}
            onClick={() => navigate(targets[key])}
          >
            <span className="browser-tab-icon">
              <Icon size={20} />
              {key === 'home' && needsYou > 0 && (
                <span className="browser-tab-badge" aria-label={`${needsYou} need you`}>
                  {needsYou}
                </span>
              )}
            </span>
            {label}
          </TooltipButton>
        )
      })}
    </nav>
  )
}
