import { decodeLocation, encodeLocation, type Location } from './location'

/** No lane data is written into history.state or browser storage. */
export function createHistoryNavigation(browser: Window) {
  const listeners = new Set<() => void>()
  let location = decodeLocation(browser.location.pathname)
  const publish = (): void => {
    location = decodeLocation(browser.location.pathname)
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: (): Location => location,
    subscribe: (listener: () => void): (() => void) => {
      if (!listeners.size) {
        location = decodeLocation(browser.location.pathname)
        browser.addEventListener('popstate', publish)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) browser.removeEventListener('popstate', publish)
      }
    },
    navigate: (next: Location, replace = false): void => {
      const path = encodeLocation(next)
      if (browser.location.pathname === path) return
      browser.history[replace ? 'replaceState' : 'pushState'](null, '', path)
      publish()
    },
    dispose: (): void => {
      browser.removeEventListener('popstate', publish)
      listeners.clear()
    },
  }
}
export type HistoryNavigation = ReturnType<typeof createHistoryNavigation>
