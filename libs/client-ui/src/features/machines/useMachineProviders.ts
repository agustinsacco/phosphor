import { useEffect, useState } from 'react'
import type { MachineProvider } from '@shared/host-protocol-machine'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/**
 * A machine's pi providers for the Machines page, read-only: This Mac's
 * subscriptions (`'local'`) or a Host's. `providers` is null while the first
 * read is in flight; a failed read says so and can be retried. Signing in
 * happens in Settings → Accounts.
 */
export function useMachineProviders(machineId: string, refresh: number) {
  const host = useRemoteLanesStore((s) => s.hosts[machineId])
  const local = machineId === 'local'
  const readable = local || (host?.state === 'ready' && host.capabilities.includes('skills.read'))
  const [providers, setProviders] = useState<MachineProvider[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    setFailed(false)
    setProviders(null)
    if (readable)
      void (
        local
          ? window.phosphor.invoke('pi:subscriptionAuth')
          : window.phosphor.invoke('hosts:providers', machineId)
      ).then(
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
  }, [machineId, local, readable, reload, refresh])
  return { readable, providers, failed, retry: () => setReload((n) => n + 1) }
}
