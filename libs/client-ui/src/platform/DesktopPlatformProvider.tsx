import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useBrain } from '@/features/brain/useBrain'
import { useLocalServiceStatus } from '@/features/updates/useLocalServiceStatus'
import { desktopPlatform, PlatformProvider } from './Platform'

/** The main-process launch decision, not the visibility of a service capability, picks the owner. */
export function DesktopPlatformProvider({
  brainPreview,
  children,
}: {
  brainPreview: boolean
  children: ReactNode
}): ReactNode {
  const { status } = useLocalServiceStatus()
  const eligible = status?.brainOwner === 'desktop'
  const [owner, setOwner] = useState(false)
  const [enabledAtLaunch, setEnabledAtLaunch] = useState(false)
  useEffect(() => {
    if (!eligible) {
      setOwner(false)
      return undefined
    }
    let active = true
    // This IPC is guarded by the durable Brain owner, independently of lane mode.
    // A refusal is expected after handover, so don't surface it as a legacy UI toast.
    void window.phosphor.invoke('brain:status').then(
      (brain) => {
        if (!active) return
        setOwner(brain.supported)
        if (!brain.supported) return
        if (brain.prefs.enabled) setEnabledAtLaunch(true)
        const existing = useBrain.getState()
        if (!existing.status && !existing.saving) useBrain.setState({ status: brain, error: '' })
      },
      () => {
        if (active) setOwner(false)
      },
    )
    return () => {
      active = false
    }
  }, [eligible])
  const platform = useMemo(
    () =>
      desktopPlatform(
        eligible && owner && enabledAtLaunch,
        eligible && owner && brainPreview,
        eligible,
      ),
    [eligible, owner, enabledAtLaunch, brainPreview],
  )
  return <PlatformProvider value={platform}>{children}</PlatformProvider>
}
