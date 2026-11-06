import { useEffect, useState } from 'react'
import type { AboutInfo } from '@shared/models'

/**
 * This app's `app:about` (About and This Mac's Advanced both read it here),
 * while `enabled`: null until it answers, "unknown" when it failed.
 */
export function useAboutInfo(enabled: boolean): AboutInfo | 'unknown' | null {
  const [about, setAbout] = useState<AboutInfo | 'unknown' | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    window.phosphor.invoke('app:about').then(
      (info) => live && setAbout(info),
      () => live && setAbout('unknown'),
    )
    return () => {
      live = false
    }
  }, [enabled])
  return about
}
