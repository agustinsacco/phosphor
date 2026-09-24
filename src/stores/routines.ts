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

/** The `editorDrafts` key for a routine that has not been saved yet. */
export const NEW_ROUTINE = 'new'

/** Unsaved editor work, plus the revision it was started from. */
export interface EditorDraft {
  input: RoutineInput
  revision: number | null
}

interface RoutinesState {
  snapshot: RoutinesSnapshot | null
  /** Lanes the routines still own; the sidebar hides exactly these paths. */
  laneIndex: RoutineLaneIndex
  error: string | null
  draft: RoutineInput | null
  /**
   * What the editor held when it closed, keyed by routine id or NEW_ROUTINE.
   * Closing the editor, by Escape or Cancel or leaving the page, must not
   * discard a half-written routine. Memory only: it does not survive a
   * restart, and instructions never touch disk until they are saved.
   */
  editorDrafts: Record<string, EditorDraft>
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
  editorDrafts: {},
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

/** Remember (or with `null`, forget) the editor's unsaved work for `key`. */
export function keepEditorDraft(key: string, draft: EditorDraft | null): void {
  useRoutinesStore.setState((s) => {
    const { [key]: _dropped, ...rest } = s.editorDrafts
    return { editorDrafts: draft ? { ...rest, [key]: draft } : rest }
  })
}

/**
 * The draft to reopen for `key`, if it is still valid. An edit started from
 * an older revision is dropped: saving it would be refused as stale anyway.
 */
export function editorDraft(key: string, revision: number | null): RoutineInput | null {
  const draft = useRoutinesStore.getState().editorDrafts[key]
  if (!draft) return null
  if (draft.revision === revision) return draft.input
  keepEditorDraft(key, null)
  return null
}

/** Reviewable draft only: never schedules or copies an active conversation. */
export function makeRoutine(workspacePath: string, name: string, instructions: string): void {
  useRoutinesStore.setState({
    draft: { ...newRoutine(workspacePath), name: name.slice(0, 100), instructions },
  })
  useLayoutStore.getState().setPage('routines')
}
