import { useEffect, useState } from 'react'
import type { MachineProvider } from '@shared/host-protocol-machine'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/**
 * A Host's pi providers for the Machines page, read-only. `providers` is null
 * while the first read is in flight; a failed read says so and can be retried.
 * Signing in happens in Settings → Accounts.
 */
export function useMachineProviders(hostId: string, refresh: number) {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const readable = host?.state === 'ready' && host.capabilities.includes('skills.read')
  const [providers, setProviders] = useState<MachineProvider[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    setFailed(false)
    setProviders(null)
    if (readable)
      void window.phosphor.invoke('hosts:providers', hostId).then(
        (rows) => {
          if (live) setProviders(rows)
        },
        () => {
          // A failed read is not "no providers".
          if (live) setFailed(true)
        },
      )
    return () => {
      live = false
    }
  }, [hostId, readable, reload, refresh])
  return { readable, providers, failed, retry: () => setReload((n) => n + 1) }
}
