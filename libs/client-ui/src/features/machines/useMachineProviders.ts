import { useEffect, useRef, useState } from 'react'
import type { MachineProvider } from '@shared/host-protocol-machine'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import {
  lastLocalSubscriptionAuth,
  readLocalSubscriptionAuth,
} from '@/stores/localSubscriptionAuth'

/**
 * A machine's pi providers for the Machines page, read-only: This Mac's
 * subscriptions (`'local'`) or a Host's. `providers` is null while the first
 * read is in flight; a failed read says so and can be retried. Signing in
 * happens in Settings → Accounts. This Mac opens on Settings' last read; Check
 * again and Retry read again.
 */
export function useMachineProviders(machineId: string, refresh: number) {
  const host = useRemoteLanesStore((s) => s.hosts[machineId])
  const local = machineId === 'local'
  const connected = local || host?.state === 'ready'
  const readable = local || (connected && !!host?.capabilities.includes('skills.read'))
  const [providers, setProviders] = useState<MachineProvider[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  // Check again's round outlives this card, so only a round that moves while it is open reads fresh.
  const opened = useRef(refresh)
  useEffect(() => {
    let live = true
    setFailed(false)
    setProviders(null)
    if (readable)
      void (
        local
          ? refresh !== opened.current || reload
            ? readLocalSubscriptionAuth()
            : lastLocalSubscriptionAuth()
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
  return { connected, readable, providers, failed, retry: () => setReload((n) => n + 1) }
}
