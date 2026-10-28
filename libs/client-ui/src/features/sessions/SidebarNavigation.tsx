import { PlusIcon } from '@/components/icons'
import { AccountFooter } from '@/features/account/AccountFooter'
import { UpdatePill } from '@/features/updates/UpdatePill'
import { useNavigation } from '@/navigation/Navigation'
import { NavigationItem } from '@/navigation/NavigationItem'
import { PageLinks } from '@/navigation/PageLinks'
import { usePlatform } from '@/platform/Platform'
import type { GlobalPage } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { MachineSwitcher, OtherMachinesActivity, type MachineScopeChange } from './MachineSwitcher'

/**
 * The top of the left navigation on every client: New, the page links and the
 * machine scope, as flat icon-and-label rows. New goes through the shell's
 * navigation with the Host in scope, so Desktop opens that Host's composer (or
 * home) and the browser moves to that machine's New page.
 */
export function SidebarNavigation({
  onPage,
  onScope,
  children,
}: {
  /** Opens a global page. Desktop toggles the page; the browser moves to its URL. */
  onPage: (page: GlobalPage) => void
  /** Where a chosen machine scope goes. Default: Desktop's persisted sidebar filter. */
  onScope?: MachineScopeChange
  /** Shell-only rows between New and the page links. */
  children?: React.ReactNode
}): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const scope = useRemoteLanesStore((s) => s.filter)
  return (
    <>
      <nav aria-label="Main navigation" className="px-2 pb-1.5">
        <NavigationItem
          label="New"
          badge
          icon={<PlusIcon strokeWidth={2.5} />}
          onClick={() =>
            navigate({
              to: 'new',
              machine: scope === 'local' || scope === 'all' ? undefined : scope,
            })
          }
        />
        {children}
        <PageLinks
          activePage={location.to === 'page' ? location.page : null}
          trailing={{ machines: <OtherMachinesActivity /> }}
          onPage={onPage}
        />
      </nav>
      <MachineSwitcher onScope={onScope} />
    </>
  )
}

/** The bottom of the left navigation: the native update notice, then the account and Settings. */
export function SidebarFooter(): React.JSX.Element {
  const { appInfo } = usePlatform()
  return (
    <div className="border-border border-t px-3 py-2">
      {appInfo && <UpdatePill />}
      <AccountFooter />
    </div>
  )
}
