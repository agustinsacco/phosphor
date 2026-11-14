import { create } from 'zustand'
import { useEffect } from 'react'
import { ARCHIVE_WARNING_BYTES, type LaneArchiveList } from '@phosphor/shared/lane-archive'
import { machineReadGeneration } from './machineReadGeneration'
import { machinesAccountGeneration } from './machines'
import { machineLabel, useRemoteLanesStore } from './remoteLanes'
import { useExtensionUiStore } from './extensionUi'

interface View {
  token?: string
  data?: LaneArchiveList
  error?: string
  loading: boolean
  revision: number
}
const EMPTY: View = Object.freeze({ loading: false, revision: 0 })
export const useArchivesStore = create<{ machines: Record<string, View> }>(() => ({ machines: {} }))
const inFlight = new Map<string, Promise<LaneArchiveList | undefined>>()
const warned = new Set<string>()
const identity = (machine: string) =>
  machine === 'local'
    ? 'local'
    : `${machine}:${machinesAccountGeneration()}:${machineReadGeneration(machine)}`
const patch = (machine: string, change: Partial<View>) =>
  useArchivesStore.setState((state) => ({
    machines: { ...state.machines, [machine]: { ...EMPTY, ...state.machines[machine], ...change } },
  }))

export function archivesChanged(machine: string): void {
  patch(machine, { revision: (useArchivesStore.getState().machines[machine]?.revision ?? 0) + 1 })
}
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
      if (data.bytes !== null && data.bytes > ARCHIVE_WARNING_BYTES && !warned.has(token)) {
        warned.add(token)
        useExtensionUiStore
          .getState()
          .pushToast(
            `${machine === 'local' ? 'This computer' : machineLabel(machine)}: archived lanes use ${(data.bytes / 1e9).toFixed(1)} GB. Open Archive to restore or clean up. Nothing is removed automatically.`,
            'info',
          )
      } else if (data.bytes !== null && data.bytes <= ARCHIVE_WARNING_BYTES) warned.delete(token)
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
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    patch(machine, { data: undefined, error: undefined })
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
  }, [machine, available, generation, view.revision])
  return view.token === generation ? view : EMPTY
}
