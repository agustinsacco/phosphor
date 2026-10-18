import { useMachinesStore } from '@/stores/machines'
import { promptChoice } from '@/stores/prompt'
import type { MachineView } from '@shared/control-api'
import { errorText } from '@shared/errors'
import { useState } from 'react'
import { confirmSettingsNavigation } from './machineSettingsDrafts'
import { useHostSettings } from './useHostSettings'

import type { MachineSettingsTab } from './MachineSettings'
import { useMachinePrograms } from './useMachinePrograms'
export function useMachineSettingsController(
  machine: Pick<MachineView, 'id' | 'label'>,
  section: MachineSettingsTab,
) {
  const [repositoryId, setRepositoryId] = useState<string | undefined>()
  const scoped = section === 'connectors' || section === 'agent'
  const settings = useHostSettings(
    machine.id,
    section === 'folders' ? 'advanced' : section,
    scoped ? repositoryId : undefined,
  )
  const { connection, allowed } = settings
  const programs = useMachinePrograms(machine, settings)
  const { setError, alive } = programs
  const [accessBusy, setAccessBusy] = useState(false)
  async function access() {
    if (
      (await promptChoice({
        title: `Enable settings access for ${machine.label}?`,
        message:
          'This grants this client authority to configure the Host, including reviewed code installs. It reconnects the link; running lanes stay on the Host and resync. Lane control alone does not grant this permission.',
        choices: [{ value: 'enable', label: `Enable for ${machine.label}`, primary: true }],
      })) !== 'enable' ||
      !alive.current
    )
      return
    setAccessBusy(true)
    setError(null)
    try {
      await window.phosphor.invoke('hosts:settingsAccess', machine.id)
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setAccessBusy(false)
    }
  }
  const select = async (next: MachineSettingsTab) => {
    if (next !== section && !(await confirmSettingsNavigation(machine.id))) return
    setError(null)
    useMachinesStore.getState().show({ kind: 'machine', id: machine.id, settings: next })
  }
  return {
    machine,
    section,
    repositoryId,
    setRepositoryId,
    scoped,
    settings,
    connection,
    allowed,
    ...programs,
    accessBusy,
    access,
    select,
  }
}
export type MachineSettingsController = ReturnType<typeof useMachineSettingsController>
