import type { HostConnectionView } from '@phosphor/shared/ipc'
import type { HostTarget } from '@phosphor/shared/remote-host'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { usePlatform } from './Platform'

export interface MachineTraits {
  viaHost: boolean
  sameMachine: boolean
}

/** A local service lane has a Host identity AND native machine access on Desktop. */
export function machineTraits(
  target: HostTarget | undefined,
  host: Pick<HostConnectionView, 'local'> | undefined,
): MachineTraits {
  const viaHost = target?.kind === 'remote'
  return { viaHost, sameMachine: !viaHost || host?.local === true }
}

export function useHostTraits(hostId: string | undefined): MachineTraits {
  const { localLanes } = usePlatform()
  const local = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId]?.local : undefined))
  const traits = machineTraits(hostId ? { kind: 'remote', hostId } : undefined, { local })
  return { ...traits, sameMachine: localLanes && traits.sameMachine }
}
