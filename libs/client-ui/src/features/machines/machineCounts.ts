import type { PhosphorApi } from '@shared/ipc'
import type { HostCapability } from '@shared/remote-host'
import { artifactOnMachine } from '@/features/artifacts/globalArtifacts'
import { routineScope } from '@/stores/machinePages'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

export type MachineCountKey = 'skills' | 'routines' | 'artifacts'
export interface MachineCount {
  key: MachineCountKey
  label: string
  /** What a Host must grant this computer before the read; This Mac needs none. */
  capability: HostCapability
  read: () => Promise<number>
}

/**
 * What a machine holds, counted one way for On this machine and the health
 * check: `'local'` for This Mac, otherwise a Host id. Archived routines do not
 * count; skills are the machine's own, without a workspace's.
 */
export function machineCounts(invoke: PhosphorApi['invoke'], machine: string): MachineCount[] {
  const local = machine === 'local'
  return [
    {
      key: 'skills',
      label: 'Skills',
      capability: 'skills.read',
      read: async () =>
        (await (local ? invoke('skills:list') : invoke('hosts:skills', machine))).skills.length,
    },
    {
      key: 'routines',
      label: 'Routines',
      capability: 'routines',
      read: async () =>
        (await invoke('routines:list', routineScope(machine))).routines.filter(
          (routine) => !routine.archived,
        ).length,
    },
    {
      key: 'artifacts',
      label: 'Artifacts',
      capability: 'artifacts.read',
      read: async () =>
        (await invoke('artifacts:list', [])).filter((artifact) =>
          artifactOnMachine(artifact.key, machine, useRemoteLanesStore.getState().hosts),
        ).length,
    },
  ]
}
