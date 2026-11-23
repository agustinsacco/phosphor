import { create } from 'zustand'
import { useArchiveChanges } from './archiveChanges'
export { archivesChanged } from './archiveChanges'
import { useEffect } from 'react'
import { ARCHIVE_WARNING_BYTES, type LaneArchiveList } from '@phosphor/shared/lane-archive'
import { machineReadGeneration } from './machineReadGeneration'
import { machinesAccountGeneration } from './machines'
import { machineLabel, useRemoteLanesStore } from './remoteLanes'
import { localMachineLabel } from '@/lib/localMachine'
import { useExtensionUiStore } from './extensionUi'

interface View {
  token?: string
  data?: LaneArchiveList
  error?: string
  loading: boolean
}
const EMPTY: View = Object.freeze({ loading: false })
export const useArchivesStore = create<{ machines: Record<string, View> }>(() => ({ machines: {} }))
const inFlight = new Map<string, Promise<LaneArchiveList | undefined>>()
const warned = new Set<string>()
const identity = (machine: string) =>
  machine === 'local'
    ? 'local'
    : `${machine}:${machinesAccountGeneration()}:${machineReadGeneration(machine)}`
/** Warn once per machine and account, not again on every reconnect. */
const warning = (machine: string) =>
  machine === 'local' ? 'local' : `${machine}:${machinesAccountGeneration()}`
const patch = (machine: string, change: Partial<View>) =>
  useArchivesStore.setState((state) => ({
    machines: { ...state.machines, [machine]: { ...EMPTY, ...state.machines[machine], ...change } },
  }))

export function loadArchives(
  machine: string,
  measure = true,
): Promise<LaneArchiveList | undefined> {
  const token = identity(machine)
  const pending = inFlight.get(token)
  if (pending) return pending
  const operation = (async () => {
    if (useArchivesStore.getState().machines[machine]?.token !== token)
      patch(machine, { data: undefined, token })
    patch(machine, { loading: true, error: undefined })
    try {
      const data =
        machine === 'local'
          ? await window.phosphor.invoke('sessions:archives', measure)
          : await window.phosphor.invoke('hosts:archives', machine, measure)
      if (identity(machine) !== token) return undefined
      patch(machine, { data })
      if (
        data.bytes !== null &&
        data.bytes > ARCHIVE_WARNING_BYTES &&
        !warned.has(warning(machine))
      ) {
        warned.add(warning(machine))
        useExtensionUiStore
          .getState()
          .pushToast(
            `${machine === 'local' ? localMachineLabel() : machineLabel(machine)}: archived lanes use ${(data.bytes / 1e9).toFixed(1)} GB. Open Archive to restore or clean up. Nothing is removed automatically.`,
            'info',
          )
      } else if (data.bytes !== null && data.bytes <= ARCHIVE_WARNING_BYTES)
        warned.delete(warning(machine))
      return data
    } catch (error) {
      if (identity(machine) === token)
        patch(machine, {
          error: error instanceof Error ? error.message : 'Archive unavailable. Try again.',
        })
      return undefined
    } finally {
      inFlight.delete(token)
      if (identity(machine) === token) patch(machine, { loading: false })
    }
  })()
  inFlight.set(token, operation)
  return operation
}

/** Only metadata polling during a measurement; expensive scans have a backend ten-minute floor. */
export function useArchiveInventory(machine: string, available: boolean): View {
  const view = useArchivesStore((state) => state.machines[machine] ?? EMPTY)
  const generation = useRemoteLanesStore(() => identity(machine))
  const revision = useArchiveChanges((state) => state[machine] ?? 0)
  // Only a different machine or identity forgets the list. A refresh keeps what
  // it already has: clearing it here blanked the page after every cleanup, which
  // unmounted the confirmation still open in that list and dropped the selection
  // that list owns. The stale rows are replaced a moment later by the refresh.
  useEffect(() => {
    patch(machine, { data: undefined, error: undefined })
  }, [machine, available, generation])
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (measure: boolean) => {
      const data = await loadArchives(machine, measure)
      if (!stopped)
        timer = setTimeout(
          () => {
            void refresh(!data?.measuring)
          },
          data?.measuring ? 3000 : 600_000,
        )
    }
    if (available) void refresh(true)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [machine, available, generation, revision])
  return view.token === generation ? view : EMPTY
}
