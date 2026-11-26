import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useBrain } from '@/features/brain/useBrain'
import { desktopPlatform, PlatformProvider } from './Platform'

const brainEnabled = (): boolean => useBrain.getState().status?.prefs.enabled === true

/**
 * Desktop renders before `brain:status` answers. The first status that arrives
 * decides whether Brain was enabled at launch; once shown, Brain stays for the
 * launch, and a failed status leaves the preview choice as it is.
 */
export function DesktopPlatformProvider({
  brainPreview,
  children,
}: {
  brainPreview: boolean
  children: ReactNode
}): ReactNode {
  const [enabledAtLaunch, setEnabledAtLaunch] = useState(brainEnabled)
  useEffect(() => {
    if (enabledAtLaunch) return undefined
    // The status can land between the first render and this effect.
    if (useBrain.getState().status) {
      if (brainEnabled()) setEnabledAtLaunch(true)
      return undefined
    }
    const off = useBrain.subscribe((state) => {
      if (!state.status) return
      off()
      if (state.status.prefs.enabled) setEnabledAtLaunch(true)
    })
    return off
  }, [enabledAtLaunch])
  const platform = useMemo(
    () => desktopPlatform(enabledAtLaunch, brainPreview),
    [enabledAtLaunch, brainPreview],
  )
  return <PlatformProvider value={platform}>{children}</PlatformProvider>
}
