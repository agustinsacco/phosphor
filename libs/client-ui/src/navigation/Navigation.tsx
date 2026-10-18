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
