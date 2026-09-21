import { useEffect } from 'react'
import { create } from 'zustand'
import {
  newRoutine,
  type RoutineInput,
  type RoutineLaneIndex,
  type RoutinesSnapshot,
} from '@shared/routines'
import { useLayoutStore } from './layout'

/** Shared frozen default: a selector must never return a fresh object. */
const NO_LANES: RoutineLaneIndex = Object.freeze({})

interface RoutinesState {
  snapshot: RoutinesSnapshot | null
  /** Lanes the routines still own; the sidebar hides exactly these paths. */
  laneIndex: RoutineLaneIndex
  error: string | null
  draft: RoutineInput | null
  refresh: () => Promise<void>
  refreshLaneIndex: () => Promise<void>
}
let sequence = 0
let laneSequence = 0
export const useRoutinesStore = create<RoutinesState>((set) => ({
  snapshot: null,
  laneIndex: NO_LANES,
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
  refreshLaneIndex: async () => {
    const request = ++laneSequence
    try {
      const laneIndex = await window.phosphor.invoke('routines:laneIndex')
      if (request === laneSequence) set({ laneIndex })
    } catch {
      // A failed lookup must not start revealing lanes mid-session: keep the
      // index we already have rather than falling back to an empty one.
    }
  },
}))

/**
 * Keep the lane index current outside the Routines page.
 *
 * The sidebar needs it on every paint, including before Routines has ever
 * been opened, so it cannot wait for that page's own refresh. Main broadcasts
 * `routines:changed` on each run transition, which is when a lane appears.
 */
export function useRoutineLaneIndex(): RoutineLaneIndex {
  const laneIndex = useRoutinesStore((s) => s.laneIndex)
  useEffect(() => {
    const refresh = (): void => void useRoutinesStore.getState().refreshLaneIndex()
    const off = window.phosphor.onRoutinesChanged(refresh)
    refresh()
    return off
  }, [])
  return laneIndex
}

/** Reviewable draft only: never schedules or copies an active conversation. */
export function makeRoutine(workspacePath: string, name: string, instructions: string): void {
  useRoutinesStore.setState({
    draft: { ...newRoutine(workspacePath), name: name.slice(0, 100), instructions },
  })
  useLayoutStore.getState().setPage('routines')
}
