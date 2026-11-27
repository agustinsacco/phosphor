import { create } from 'zustand'
import type { HostsSnapshot } from '@shared/ipc'
import { hostPhase, hostStarting, MACHINE_START_LIMIT_MS, type HostPhase } from './hostReadiness'
import { useRemoteLanesStore } from './remoteLanes'

/**
 * This Mac's boot windows that outlasted `MACHINE_START_LIMIT_MS`, by Host id. A
 * window starts when the service first reads as starting and ends when it stops
 * (ready, reconnecting or gone), so the next boot gets a fresh one.
 */
const useStartLimitStore = create<{ expired: Record<string, true> }>(() => ({ expired: {} }))
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function expire(hostId: string): void {
  timers.delete(hostId)
  useStartLimitStore.setState((s) => ({ expired: { ...s.expired, [hostId]: true } }))
}

function clear(hostId: string): void {
  clearTimeout(timers.get(hostId))
  timers.delete(hostId)
  if (!useStartLimitStore.getState().expired[hostId]) return
  useStartLimitStore.setState((s) => {
    const expired = { ...s.expired }
    delete expired[hostId]
    return { expired }
  })
}

function track(hosts: HostsSnapshot): void {
  const ids = new Set([...timers.keys(), ...Object.keys(useStartLimitStore.getState().expired)])
  for (const [hostId, host] of Object.entries(hosts)) {
    ids.delete(hostId)
    if (!hostStarting(host)) clear(hostId)
    else if (!timers.has(hostId) && !useStartLimitStore.getState().expired[hostId])
      timers.set(
        hostId,
        setTimeout(() => expire(hostId), MACHINE_START_LIMIT_MS),
      )
  }
  for (const hostId of ids) clear(hostId)
}

track(useRemoteLanesStore.getState().hosts)
useRemoteLanesStore.subscribe((s, prev) => {
  if (s.hosts !== prev.hosts) track(s.hosts)
})

/** The Host's phase (`hostPhase`), with This Mac's boot window cut off at its limit. */
export function useHostPhase(hostId: string | undefined): HostPhase {
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const expired = useStartLimitStore((s) => !!hostId && !!s.expired[hostId])
  return hostPhase(host, expired)
}

/** Retry after the boot window ran out: reconnect, and give the service a fresh window. */
export async function retryMachineStart(hostId: string): Promise<void> {
  clear(hostId)
  track(useRemoteLanesStore.getState().hosts)
  await window.phosphor.invoke('hosts:reconnect', hostId)
}
