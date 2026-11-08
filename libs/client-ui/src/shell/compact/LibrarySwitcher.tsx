import { Segmented } from '@/components/form'
import { useNavigation } from '@/navigation/Navigation'
import { SCREENS } from '@/navigation/screens'
import { LIBRARY_PAGES, type LibraryPage } from './browserMemory'

const OPTIONS = LIBRARY_PAGES.map((page) => ({ value: page, label: SCREENS[page].title }))

/** The Library tab's three pages, one tap apart; each keeps the machine in view. */
export function LibrarySwitcher({
  page,
  machine,
}: {
  page: LibraryPage
  machine?: string
}): React.JSX.Element {
  const { navigate } = useNavigation()
  return (
    <div className="library-switcher">
      <Segmented
        label="Library"
        value={page}
        options={OPTIONS}
        onChange={(next) => navigate({ to: 'page', page: next, ...(machine ? { machine } : {}) })}
      />
    </div>
  )
}
