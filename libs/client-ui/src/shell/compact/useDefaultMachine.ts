import { useEffect } from 'react'
import type { HistoryNavigation } from '@/navigation/history'
import type { Location } from '@/navigation/location'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { scopedMachine, useBrowserMemory } from './browserMemory'

/** Screens that cannot show without a machine: New, Skills and Routines. */
type Scoped = Extract<Location, { to: 'new' } | { to: 'page' }>
const needsMachine = (location: Location): location is Scoped =>
  (location.to === 'new' ||
    (location.to === 'page' && (location.page === 'skills' || location.page === 'routines'))) &&
  !location.machine

/**
 * A screen that needs a machine and has none in its URL opens on the scoped one (the last
 * machine looked at, else the first that can start a lane), pinned in the URL before use.
 */
export function useDefaultMachine(
  history: HistoryNavigation,
  location: Location,
  enabled: boolean,
): void {
  const machines = useMachinesStore((s) => s.machines)
  const loading = useMachinesStore((s) => s.loading)
  const error = useMachinesStore((s) => s.error)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const lastMachine = useBrowserMemory((s) => s.lastMachine)
  useEffect(() => {
    if (!enabled || loading || error || !needsMachine(location)) return
    const machine = scopedMachine(undefined, lastMachine, machines, hosts)
    if (machine) history.navigate({ ...location, machine }, true)
  }, [enabled, error, history, hosts, lastMachine, loading, location, machines])
}
