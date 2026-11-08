import { useEffect } from 'react'
import { rememberRemoteRepository } from '@/features/home/remoteComposer'
import { useNavigation } from '@/navigation/Navigation'
import { locationMachine, type Location } from '@/navigation/location'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { rememberLocation, scopedMachine, useBrowserMemory } from './browserMemory'

/** `scopedMachine` for the current location. */
export function useScopedMachine(): string | undefined {
  const { location } = useNavigation()
  const lastMachine = useBrowserMemory((s) => s.lastMachine)
  const machines = useMachinesStore((s) => s.machines)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  return scopedMachine(locationMachine(location), lastMachine, machines, hosts)
}

/**
 * Keeps the browser's memory of where you are. An open Host lane also makes its folder
 * that machine's start folder, so New opens where you last worked.
 */
export function useRememberWhere(location: Location): void {
  const lane = location.to === 'lane' && 'hostId' in location.lane ? location.lane : null
  const repositoryId = useRemoteLanesStore((s) =>
    lane
      ? s.hosts[lane.hostId]?.lanes.find((item) => item.laneId === lane.laneId)?.repositoryId
      : undefined,
  )
  const hostId = lane?.hostId
  useEffect(() => rememberLocation(location), [location])
  useEffect(() => {
    if (hostId && repositoryId) rememberRemoteRepository(hostId, repositoryId)
  }, [hostId, repositoryId])
}
