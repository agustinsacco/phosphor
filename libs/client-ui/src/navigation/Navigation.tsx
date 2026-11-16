import { createContext, useContext } from 'react'
import { navigateDesktop, useDesktopLocation } from './desktopNavigation'
import type { Location } from './location'

export interface Navigation {
  location: Location
  navigate: (next: Location) => void
}
const NavigationContext = createContext<Navigation | null>(null)
export const NavigationProvider = NavigationContext.Provider
/** Native defaults project the existing stores; browser supplies real history. */
export function useNavigation(): Navigation {
  const browser = useContext(NavigationContext)
  const desktop = useDesktopLocation()
  return (
    browser ?? {
      location: desktop,
      navigate: (next) => {
        void navigateDesktop(next)
      },
    }
  )
}
/**
 * `navigate` for a caller that waits on it: Desktop's resolves once the
 * destination is open (a Host lane is opened on its Host first); the
 * browser's changes the route at once, and the page loads the rest.
 */
export function useAwaitableNavigate(): (next: Location) => Promise<void> {
  const browser = useContext(NavigationContext)
  if (!browser) return navigateDesktop
  return (next) => {
    browser.navigate(next)
    return Promise.resolve()
  }
}
