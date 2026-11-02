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

