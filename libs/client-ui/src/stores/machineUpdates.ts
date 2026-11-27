import { create } from 'zustand'
import type { MachineUpdateEntry } from '@/features/updates/machineUpdateState'
import type { FooterState } from '@/features/updates/updatesFooterRows'

export const EMPTY_MACHINE_UPDATE: MachineUpdateEntry = Object.freeze({})
export const useMachineUpdatesStore = create<{
  byMachine: Record<string, MachineUpdateEntry>
  /** When the shell's observer started: the app's start, which the footer's start delay counts from. */
  startedAt?: number
  /** The bottom-left rows' dwell and collapse, shared by every mount. */
  footer?: FooterState
}>(() => ({ byMachine: {} }))

export function machineUpdateEntry(id: string): MachineUpdateEntry {
  return useMachineUpdatesStore.getState().byMachine[id] ?? EMPTY_MACHINE_UPDATE
}

export function updateMachineEntry(
  id: string,
  change: (entry: MachineUpdateEntry) => MachineUpdateEntry,
): void {
  useMachineUpdatesStore.setState((state) => {
    const before = state.byMachine[id] ?? EMPTY_MACHINE_UPDATE
    const after = change(before)
    return before === after ? state : { byMachine: { ...state.byMachine, [id]: after } }
  })
}
