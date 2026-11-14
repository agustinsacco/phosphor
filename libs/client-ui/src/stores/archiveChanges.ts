import { create } from 'zustand'

/** Mutation invalidation stays independent of session, machine and page initialization. */
export const useArchiveChanges = create<Record<string, number>>(() => ({}))
export function archivesChanged(machine: string): void {
  useArchiveChanges.setState((state) => ({ [machine]: (state[machine] ?? 0) + 1 }))
}
