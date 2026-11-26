import { SoftwareUpdateRow } from '@/features/updates/SoftwareUpdateRow'
import { useAppUpdate } from '@/features/updates/useAppUpdate'
import { usePlatform } from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'
import { useHostSection } from '../../machine/HostSection'
import { MachineUpdateRow } from './MachineRuntimeRows'

function DesktopUpdateRow() {
  const update = useAppUpdate()
  return <MachineUpdateRow title="Phosphor updates" update={update} />
}

export function HostSoftware() {
  const { machine, settings, allowed } = useHostSection()
  const platform = useMachinesStore(
    (s) => s.machines.find((record) => record.id === machine.id)?.platform,
  )
  const { appInfo } = usePlatform()
  return (
    <SoftwareUpdateRow
      id={machine.id}
      label={machine.label}
      configure={allowed}
      platform={
        (settings.connection?.local
          ? window.phosphor.platform
          : settings.data?.advanced?.platform) ?? platform
      }
    >
      {settings.connection?.local && appInfo && <DesktopUpdateRow />}
    </SoftwareUpdateRow>
  )
}
