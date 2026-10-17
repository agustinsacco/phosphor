import { create } from 'zustand'
import { useMachinesStore } from '@/stores/machines'
import { runHealthCheck, type HealthRun } from './healthCheck'
import { localMachineLabel } from './machinePresentation'

/** The last health check in this window. Never persisted; a new run replaces it. */
export const useMachineHealthStore = create<{ run: HealthRun | null; running: boolean }>(() => ({
  run: null,
  running: false,
}))

let current = 0
export async function startHealthCheck(): Promise<void> {
  const id = ++current
  useMachineHealthStore.setState({ running: true })
  try {
    await runHealthCheck({
      invoke: window.phosphor.invoke,
      localLabel: localMachineLabel(window.phosphor.platform),
      signedIn: useMachinesStore.getState().remoteEnabled,
      refreshDirectory: async () => {
        await useMachinesStore.getState().refresh()
        return useMachinesStore.getState().error
      },
      machines: () => useMachinesStore.getState().machines,
      hosts: () => window.phosphor.invoke('hosts:snapshot'),
      now: () => Date.now() + useMachinesStore.getState().clockOffsetMs,
      onUpdate: (run) => {
        if (id === current) useMachineHealthStore.setState({ run })
      },
    })
  } finally {
    if (id === current) useMachineHealthStore.setState({ running: false })
  }
}

/** Forget results when the account changes: they described another account's machines. */
useMachinesStore.subscribe((state, previous) => {
  if (state.remoteEnabled !== previous.remoteEnabled) {
    current++
    useMachineHealthStore.setState({ run: null, running: false })
  }
})
