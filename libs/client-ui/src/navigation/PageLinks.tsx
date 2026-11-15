import { useBrain, useBrainSync } from '@/features/brain/useBrain'
import { usePlatform } from '@/platform/Platform'
import type { GlobalPage } from '@/stores/layout'
import { NavigationItem } from './NavigationItem'
import { SCREENS } from './screens'

const GLOBAL_PAGES = ['artifacts', 'skills', 'routines', 'machines', 'brain'] as const

/** Shared order, labels and icons. Shells only supply their navigation action. */
export function PageLinks({
  activePage,
  trailing,
  onPage,
}: {
  activePage?: GlobalPage | 'settings' | null
  /** Per-page status at the row's right edge. Desktop's sidebar uses it for Machines. */
  trailing?: Partial<Record<GlobalPage, React.ReactNode>>
  onPage: (page: GlobalPage) => void
}): React.JSX.Element {
  useBrainSync()
  const enabled = useBrain((s) => s.status?.prefs.enabled)
  const reviews = useBrain(
    (s) => s.status?.jobs.filter((job) => job.state === 'review').length ?? 0,
  )
  const localBrain = usePlatform().localBrain
  return (
    <>
      {GLOBAL_PAGES.filter((page) => page !== 'brain' || (localBrain && enabled)).map((page) => {
        const { title, icon: Icon } = SCREENS[page]
        return (
          <NavigationItem
            key={page}
            label={title}
            icon={<Icon />}
            active={activePage === page}
            trailing={
              page === 'brain' && reviews > 0 ? (
                <span
                  className="text-accent ml-auto text-xs tabular-nums"
                  aria-label={`${reviews} lanes to review`}
                >
                  {reviews}
                </span>
              ) : (
                trailing?.[page]
              )
            }
            onClick={() => onPage(page)}
          />
        )
      })}
    </>
  )
}
