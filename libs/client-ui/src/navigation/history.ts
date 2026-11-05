import { decodeLocation, encodeLocation, type Location } from './location'

/**
 * No lane data is written into history.state or browser storage. `hold(from, to)`
 * may keep `from` on Back or Forward: its URL is pushed again and `hold` owns
 * going on to `to`.
 */
export function createHistoryNavigation(
  browser: Window,
  hold?: (from: Location, to: Location) => boolean,
) {
  const listeners = new Set<() => void>()
  let location = decodeLocation(browser.location.pathname)
  const publish = (): void => {
    location = decodeLocation(browser.location.pathname)
    for (const listener of listeners) listener()
  }
  const pop = (): void => {
    if (!hold?.(location, decodeLocation(browser.location.pathname))) return publish()
    browser.history.pushState(null, '', encodeLocation(location))
  }
  return {
    getSnapshot: (): Location => location,
    subscribe: (listener: () => void): (() => void) => {
      if (!listeners.size) {
        location = decodeLocation(browser.location.pathname)
        browser.addEventListener('popstate', pop)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) browser.removeEventListener('popstate', pop)
      }
    },
    navigate: (next: Location, replace = false): void => {
      const path = encodeLocation(next)
      if (browser.location.pathname === path) return
      browser.history[replace ? 'replaceState' : 'pushState'](null, '', path)
      publish()
    },
    dispose: (): void => {
      browser.removeEventListener('popstate', pop)
      listeners.clear()
    },
  }
}
export type HistoryNavigation = ReturnType<typeof createHistoryNavigation>
