import { useEffect, useState } from 'react'
import { canConfigureHost } from '@/features/settings/machine/useHostSettings'
import { usePlatform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/**
 * The pi a Host runs, from its Advanced settings, where this device may read
 * them. Null where it may not (no row), otherwise what the Details row says.
 */
export function useHostPiVersion(hostId: string, refresh: number): string | null {
  const { machineSettings } = usePlatform()
  const connection = useRemoteLanesStore((s) => s.hosts[hostId])
  const allowed = canConfigureHost(machineSettings, connection)
  const [read, setRead] = useState<{ key: string; version: string } | null>(null)
  const key = `${hostId}:${connection?.connectionToken}:${refresh}`
  useEffect(() => {
    if (!allowed) return
    let live = true
    void window.phosphor.invoke('hosts:settingsRead', hostId, 'advanced').then(
      (settings) => {
        if (live) setRead({ key, version: settings.advanced?.pi?.version ?? 'Not reported' })
      },
      () => {
        if (live) setRead({ key, version: 'Not available' })
      },
    )
    return () => {
      live = false
    }
  }, [allowed, hostId, key])
  if (!allowed) return null
  return read?.key === key ? read.version : 'Checking…'
}
