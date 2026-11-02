import { MachineConnectorSettings } from '@/features/machines/MachineConnectorSettings'
import {
  MachineAdvancedSettings,
  MachineFolderSettings,
} from '@/features/machines/MachineExecutionSettings'
import { MachineProviderSettings } from '@/features/machines/MachineProviderSettings'
import { useHostSection } from '../machine/HostSection'

/*
 * Each Host section's view through `useHostSection()`. These wrap the Host's
 * own section views until each section has one shared view (sections/<section>/).
 */

export function HostAccountsSection(): React.JSX.Element {
  const { machine, settings, programs } = useHostSection()
  return (
    <MachineProviderSettings
      hostId={machine.id}
      label={machine.label}
      settings={settings}
      programs={programs}
    />
  )
}

export function HostConnectorsSection(): React.JSX.Element {
  const { machine, settings, programs, repositoryId } = useHostSection()
  return (
    <MachineConnectorSettings
      label={machine.label}
      settings={settings}
      programs={programs}
      repositoryId={repositoryId}
    />
  )
}

export function HostFoldersSection(): React.JSX.Element {
  const { machine, programs } = useHostSection()
  return <MachineFolderSettings hostId={machine.id} label={machine.label} programs={programs} />
}

export function HostAdvancedSection(): React.JSX.Element {
  const { machine, settings, programs } = useHostSection()
  return <MachineAdvancedSettings label={machine.label} settings={settings} programs={programs} />
}
