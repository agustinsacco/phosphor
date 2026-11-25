import type { MachineSettingsPatch } from '@shared/machine-settings'
import { machineModelDefaults } from '@shared/host-protocol-machine'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { recheckMachineCatalogue } from '@/stores/machineCatalogues'

/** A committed patch can change which models pi discovers. The save's own global
 * defaults also apply immediately, including on Hosts whose catalogue omits defaults. */
export async function patchHostSettings(hostId: string, patch: MachineSettingsPatch) {
  const generation = machineReadGeneration(hostId)
  const saved = await window.phosphor.invoke('hosts:settingsPatch', hostId, patch)
  if (machineReadGeneration(hostId) === generation) {
    const defaults =
      !patch.repositoryId && patch.change.type === 'agent.patch' && saved.agent
        ? (machineModelDefaults({ ...saved.agent }) ?? null)
        : undefined
    recheckMachineCatalogue(hostId, defaults)
  }
  return saved
}
