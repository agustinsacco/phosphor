import { usePlatform } from '@/platform/Platform'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { MachineGlyph } from '@/features/sessions/MachineSwitcher'
import type { HostCapability } from '@shared/remote-host'
import type { HostConnectionView } from '@shared/ipc'
import { hostReconnecting, machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'

/** A machine that is coming back is connecting, not disconnected. */
function stateSuffix(host: HostConnectionView | undefined): string {
  if (!host || host.state === 'ready') return ''
  return hostReconnecting(host.state) ? ' (connecting…)' : ' (not connected)'
}

/** Never resets an unavailable selection to the local machine. */
export function MachinePicker({
  value,
  capability,
  onChange,
  includeAll = false,
  placement,
  bordered,
}: {
  value: string
  capability: HostCapability
  onChange: (machine: string) => void
  includeAll?: boolean
  placement?: 'above' | 'below'
  bordered?: boolean
}): React.JSX.Element {
  const { localLanes } = usePlatform()
  const hosts = useRemoteLanesStore((s) => s.hosts)
  useMachinesStore((s) => s.machines)
  const choices = Object.entries(hosts).filter(([, host]) => host.capabilities.includes(capability))
  const unavailable =
    value !== 'local' && !(includeAll && value === '') && !choices.some(([id]) => id === value)
  return (
    <ChoiceMenu
      label="Machine"
      bordered={bordered}
      placement={placement}
      value={value}
      onChange={onChange}
      choices={[
        ...(includeAll ? [{ value: '', label: 'All machines' }] : []),
        ...(localLanes ? [{ value: 'local', label: 'This Mac' }] : []),
        ...(unavailable
          ? [{ value, label: `${machineLabel(value)} (unavailable)`, disabled: true }]
          : []),
        ...choices.map(([id, host]) => ({
          value: id,
          label: `${machineLabel(id)}${stateSuffix(host)}`,
        })),
      ]}
    >
      <MachineGlyph local={value === 'local'} />
      <span className="truncate">
        {value === 'local'
          ? 'This Mac'
          : includeAll && value === ''
            ? 'All machines'
            : machineLabel(value)}
        {unavailable ? ' (unavailable)' : stateSuffix(hosts[value])}
      </span>
    </ChoiceMenu>
  )
}
