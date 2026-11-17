import { useEffect } from 'react'
import { usePlatform } from '@/platform/Platform'
import { createTidyNotices } from './tidy/tidyNotices'
import { brainInFlight, useBrain } from './useBrain'

// Kept apart from the store: notices reach the layout store, which the lazy graph must not load.
let subscribers = 0
let stop: (() => void) | null = null
function subscribe(): () => void {
  subscribers++
  if (subscribers === 1) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true
    const notice = createTidyNotices()
    notice(useBrain.getState().status)
    const schedule = (): void => {
      clearTimeout(timer)
      if (
        active &&
        document.visibilityState !== 'hidden' &&
        (brainInFlight(useBrain.getState().status) || useBrain.getState().status?.prefs.enabled)
      ) {
        timer = setTimeout(
          () => {
            void useBrain.getState().refresh().then(schedule)
          },
          brainInFlight(useBrain.getState().status) ? 2000 : 10000,
        )
      }
    }
    const visible = (): void => {
      if (document.visibilityState !== 'hidden') void useBrain.getState().refresh()
      schedule()
    }
    const off = useBrain.subscribe((state) => {
      notice(state.status)
      schedule()
    })
    document.addEventListener('visibilitychange', visible)
    stop = () => {
      active = false
      notice(null)
      clearTimeout(timer)
      off()
      document.removeEventListener('visibilitychange', visible)
    }
    void useBrain.getState().refresh()
    schedule()
  }
  return () => {
    if (--subscribers === 0) {
      stop?.()
      stop = null
    }
  }
}

/** One visible-window poller: fast during work, quiet while enabled to discover lane flags. */
export function useBrainSync(ready = true): void {
  const supported = usePlatform().localBrain
  useEffect(() => {
    if (supported && ready) return subscribe()
    return undefined
  }, [supported, ready])
}
