import { useEffect } from 'react'
import type { HistoryNavigation } from '@/navigation/history'
import type { Location } from '@/navigation/location'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/** Only an unambiguous ready target is automatic; pin it in the URL before use. */
export function useDefaultNewMachine(
  history: HistoryNavigation,
  location: Location,
  enabled: boolean,
): void {
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading)
  const error = useMachinesStore((s) => s.error)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  useEffect(() => {
    if (!enabled || loading || error || location.to !== 'new' || location.machine) return
    const ready = machines.filter((machine) => {
      const host = hosts[machine.id]
      return host?.state === 'ready' && host.capabilities.includes('sessions.control')
    })
    if (ready.length === 1) history.navigate({ to: 'new', machine: ready[0]!.id }, true)
  }, [enabled, error, history, hosts, loading, location, machines])
}
