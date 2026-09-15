import { create } from 'zustand'
import { newRoutine, type RoutineInput, type RoutinesSnapshot } from '@shared/routines'
import { useLayoutStore } from './layout'

interface RoutinesState {
  snapshot: RoutinesSnapshot | null
  error: string | null
  draft: RoutineInput | null
  refresh: () => Promise<void>
}
let sequence = 0
export const useRoutinesStore = create<RoutinesState>((set) => ({
  snapshot: null,
  error: null,
  draft: null,
  refresh: async () => {
    const request = ++sequence
    try {
      const snapshot = await window.phosphor.invoke('routines:list')
      if (request === sequence) set({ snapshot, error: snapshot.error })
    } catch (error) {
      if (request === sequence) set({ error: String(error) })
    }
  },
}))

/** Reviewable draft only: never schedules or copies an active conversation. */
export function makeRoutine(workspacePath: string, name: string, instructions: string): void {
  useRoutinesStore.setState({
    draft: { ...newRoutine(workspacePath), name: name.slice(0, 100), instructions },
  })
  useLayoutStore.getState().setPage('routines')
}
