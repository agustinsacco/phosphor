import { InstallApp } from './InstallApp'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useNavigation } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { usePlatform } from '@/platform/Platform'
import { RemoteLanes } from '@/features/sessions/RemoteLanes'
import { SidebarFooter, SidebarNavigation } from '@/features/sessions/SidebarNavigation'

/** A wide browser's left column: Desktop's sidebar navigation over the Host lane tree. */
export function BrowserNavigation({ machine }: { machine?: string }): React.JSX.Element {
  const { location, navigate } = useNavigation()
  const { installableApp } = usePlatform()
  return (
    <aside className="browser-navigation">
      <div className="browser-brand">
        <PhosphorLoader size={26} decorative animated={false} />
        <strong>Phosphor</strong>
      </div>
      <SidebarNavigation
        onPage={(page) =>
          navigate({ to: 'page', page, machine: page === 'machines' ? undefined : machine })
        }
        onScope={(scope) => navigate(scopedLocation(location, scope))}
      />
      <div data-session-scroll className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <RemoteLanes />
      </div>
      <SidebarFooter />
      {installableApp && (
        <div className="browser-install-nav">
          <InstallApp />
        </div>
      )}
      <p className="browser-navigation-note">Connected directly to your machines.</p>
    </aside>
  )
}

/** The browser keeps the machine scope in the URL; a lane or dead link falls back to its list. */
function scopedLocation(location: Location, scope: string): Location {
  const machine = scope === 'all' ? undefined : scope
  return location.to === 'lane' || location.to === 'unavailable'
    ? { to: 'lanes', machine }
    : { ...location, machine }
}
