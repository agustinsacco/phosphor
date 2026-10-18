import type { HostConnectionView } from '@shared/ipc'
import { useRemoteLanesStore } from './remoteLanes'

function identity(host: HostConnectionView | undefined): string {
  return JSON.stringify([
    host?.state,
    host?.connectionToken,
    host?.cursor?.epoch,
    host?.capabilities
      .filter((cap) =>
        ['skills.read', 'routines', 'artifacts.read', 'machine.configure'].includes(cap),
      )
      .sort(),
  ])
}

const generations = new Map<string, number>()
// Observe every transition, including ready -> reconnecting -> ready between React renders.
useRemoteLanesStore.subscribe((state, previous) => {
  for (const hostId of new Set([...Object.keys(state.hosts), ...Object.keys(previous.hosts)])) {
    if (identity(state.hosts[hostId]) !== identity(previous.hosts[hostId]))
      generations.set(hostId, (generations.get(hostId) ?? 0) + 1)
  }
})

export function machineReadGeneration(hostId: string): number {
  return generations.get(hostId) ?? 0
}
