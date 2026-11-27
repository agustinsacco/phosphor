import type { HostsSnapshot } from '@shared/ipc'
import { localServiceId } from '@/stores/localServiceScope'

/** A local slot identifies the lane runtime, not necessarily the Brain owner. */
export function brainMachine(machine: string, hosts: HostsSnapshot, desktopBrain: boolean) {
  const local = localServiceId(hosts)
  if (machine !== 'local' && machine !== local) return machine
  if (desktopBrain) return 'local'
  return local ?? 'local'
}
