import { ChoiceMenu } from '@/components/ChoiceMenu'
import { MachineGlyph } from '@/features/sessions/MachineSwitcher'
import type { HostCapability } from '@shared/remote-host'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'

/** Never resets an unavailable selection to the local machine. */
export function MachinePicker({
  value,
  capability,
  onChange,
  includeAll = false,
  placement,
}: {
  value: string
  capability: HostCapability
  onChange: (machine: string) => void
  includeAll?: boolean
  placement?: 'above' | 'below'
}): React.JSX.Element {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  useMachinesStore((s) => s.machines)
  const choices = Object.entries(hosts).filter(([, host]) => host.capabilities.includes(capability))
  const unavailable =
    value !== 'local' && !(includeAll && value === '') && !choices.some(([id]) => id === value)
  return (
    <ChoiceMenu
      label="Machine"
      placement={placement}
      value={value}
      onChange={onChange}
      choices={[
        ...(includeAll ? [{ value: '', label: 'All machines' }] : []),
        { value: 'local', label: 'This Mac' },
        ...(unavailable
          ? [{ value, label: `${machineLabel(value)} (unavailable)`, disabled: true }]
          : []),
        ...choices.map(([id, host]) => ({
          value: id,
          label: `${machineLabel(id)}${host.state === 'ready' ? '' : ' (not connected)'}`,
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
        {unavailable ? ' (unavailable)' : ''}
      </span>
    </ChoiceMenu>
  )
}
