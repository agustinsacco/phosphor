import type { GlobalPage } from '@/stores/layout'
import { NavigationItem } from './NavigationItem'
import { SCREENS } from './screens'

const GLOBAL_PAGES = ['artifacts', 'skills', 'routines', 'machines'] as const

/** Shared order, labels and icons. Shells only supply their navigation action. */
export function PageLinks({
  activePage,
  onPage,
}: {
  activePage?: GlobalPage | 'settings' | null
  onPage: (page: GlobalPage) => void
}): React.JSX.Element {
  return (
    <>
      {GLOBAL_PAGES.map((page) => {
        const { title, icon: Icon } = SCREENS[page]
        return (
          <NavigationItem
            key={page}
            label={title}
            icon={<Icon />}
            active={activePage === page}
            onClick={() => onPage(page)}
          />
        )
      })}
    </>
  )
}
