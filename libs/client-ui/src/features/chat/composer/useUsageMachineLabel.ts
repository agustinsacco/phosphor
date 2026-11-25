import { localMachineLabel } from '@/lib/localMachine'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'

export function useUsageMachineLabel(hostId: string | undefined): string {
  const local = useRemoteLanesStore((s) => hostId !== undefined && s.hosts[hostId]?.local)
  const label = useMachinesStore((s) => s.machines.find((m) => m.id === hostId)?.label)
  return local ? localMachineLabel() : (label ?? 'remote machine')
}
