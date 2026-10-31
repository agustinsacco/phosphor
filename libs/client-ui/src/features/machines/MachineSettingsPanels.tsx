import { MachineConnectorSettings } from './MachineConnectorSettings'
import {
  MachineAdvancedSettings,
  MachineAgentSettings,
  MachineFolderSettings,
  MachineResourceSettings,
} from './MachineExecutionSettings'
import { MachineProviderSettings } from './MachineProviderSettings'

import type { MachineSettingsController } from './useMachineSettingsController'
type ControllerProps = { controller: MachineSettingsController }

export function MachineSettingsPanels({ controller }: ControllerProps): React.JSX.Element {
  const { machine, section, settings, programs, repositoryId } = controller
  return (
    <>
      {section === 'providers' && (
        <MachineProviderSettings
          hostId={machine.id}
          label={machine.label}
          settings={settings}
          programs={programs}
        />
      )}
      {section === 'connectors' && (
        <MachineConnectorSettings
          label={machine.label}
          settings={settings}
          programs={programs}
          repositoryId={repositoryId}
        />
      )}
      {section === 'agent' && (
        <MachineAgentSettings
          key={repositoryId ?? 'machine'}
          hostId={machine.id}
          label={machine.label}
          settings={settings}
          repositoryId={repositoryId}
        />
      )}
      {section === 'folders' && (
        <MachineFolderSettings hostId={machine.id} label={machine.label} programs={programs} />
      )}
      {section === 'resources' && (
        <MachineResourceSettings
          hostId={machine.id}
          label={machine.label}
          settings={settings}
          programs={programs}
        />
      )}
      {section === 'advanced' && (
        <MachineAdvancedSettings label={machine.label} settings={settings} programs={programs} />
      )}
    </>
  )
}
