import { useState } from 'react'
import type { MachineView } from '@shared/control-api'
import { Toggle } from '@/components/form'
import { machinesAccountGeneration, useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { Card } from './MachineUi'
import { controlMessage } from './controlMessages'

const OLD_CONTROL = "Other machines are unavailable until Phosphor's service updates."

/** Reach is a control-plane setting. Even an offline Host can have its reach turned off. */
export function MachineReach({ machine }: { machine: MachineView }): React.JSX.Element {
  const connection = useRemoteLanesStore((state) => state.hosts[machine.id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notFound, setNotFound] = useState(false)
  const unavailable =
    notFound || machine.machineReach === undefined
      ? OLD_CONTROL
      : connection?.state === 'ready' && !connection.ops
        ? 'Other machines are unavailable. Update this Host to use machine reach.'
        : !machine.machineGrants
          ? 'Other machines are unavailable. Update this Host or check that machine operations are enabled.'
          : null
  async function save(enabled: boolean): Promise<void> {
    if (busy || unavailable) return
    setBusy(true)
    setError(undefined)
    const generation = machinesAccountGeneration()
    try {
      const result = await window.phosphor.invoke('control:setMachineReach', machine.id, enabled)
      if (generation !== machinesAccountGeneration()) return
      if (result.ok) {
        useMachinesStore.setState((state) => ({
          machines: state.machines.map((entry) =>
            entry.id === machine.id ? { ...entry, machineReach: result.machineReach } : entry,
          ),
        }))
      } else if (result.error.code === 'not-found') setNotFound(true)
      else setError(controlMessage(result.error.code))
    } catch {
      if (generation === machinesAccountGeneration()) setError(controlMessage('offline'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      title="Machine reach"
      aside={
        !unavailable && (
          <Toggle
            label="Machine reach"
            disabled={busy}
            on={machine.machineReach === true}
            onChange={(on) => void save(on)}
          />
        )
      }
    >
      <p className="text-text-secondary text-base">
        {unavailable ??
          'Machine reach is on by default. When on, agents on this machine can act on your other reach-enabled machines, and their agents can act on this one.'}
      </p>
      {error && !unavailable && (
        <p role="alert" className="text-danger text-base">
          {error}
        </p>
      )}
    </Card>
  )
}
