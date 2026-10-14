import type { HostCapability } from '@shared/remote-host'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'

/** Never resets an unavailable selection to the local machine. */
export function MachinePicker({
  value,
  capability,
  onChange,
  includeAll = false,
}: {
  value: string
  capability: HostCapability
  onChange: (machine: string) => void
  includeAll?: boolean
}): React.JSX.Element {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  useMachinesStore((s) => s.machines)
  const choices = Object.entries(hosts).filter(([, host]) => host.capabilities.includes(capability))
  return (
    <select
      aria-label="Machine"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="bg-bg-secondary rounded px-2 py-1"
    >
      {includeAll && <option value="">All machines</option>}
      <option value="local">This Mac</option>
      {value !== 'local' &&
        !(includeAll && value === '') &&
        !choices.some(([id]) => id === value) && (
          <option value={value} disabled>
            {machineLabel(value)} (unavailable)
          </option>
        )}
      {choices.map(([id, host]) => (
        <option key={id} value={id}>
          {machineLabel(id)}
          {host.state === 'ready' ? '' : ' (not connected)'}
        </option>
      ))}
    </select>
  )
}
