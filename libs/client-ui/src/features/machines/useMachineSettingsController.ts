import { useMachinesStore } from '@/stores/machines'
import type { MachineView } from '@shared/control-api'
import { errorText } from '@shared/errors'
import { useState } from 'react'
import { confirmSettingsNavigation } from './machineSettingsDrafts'
import { useHostSettings } from './useHostSettings'

import type { MachineSettingsTab } from './MachineSettings'
import { useMachinePrograms } from './useMachinePrograms'
import { confirmSettingsAccess } from './settingsAccess'
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
    if (!(await confirmSettingsAccess(machine.label)) || !alive.current) return
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
