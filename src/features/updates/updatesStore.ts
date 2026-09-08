import { create } from 'zustand'
import type { UpdateState } from '@shared/models'

/**
 * Update state, mirrored from main.
 *
 * A pure projection: main owns the schedule and the state machine, so this
 * store only records what it is told and forwards the two user actions.
 */
interface UpdatesStoreState {
  update: UpdateState
  /** True while an install/open is in flight, so the button can't double-fire. */
  acting: boolean
  subscribe: () => () => void
  restartAndInstall: () => Promise<void>
  check: () => Promise<void>
}

export const useUpdatesStore = create<UpdatesStoreState>((set, get) => ({
  update: { phase: 'idle' },
  acting: false,

  subscribe: () => {
    const unsubscribe = window.phosphor.onUpdateEvent((update) => set({ update }))
    // Read the current state too: main may have found an update before this
    // window existed (or before the user opened a second one).
    void window.phosphor.invoke('updates:state').then((update) => {
      if (update) set({ update })
    })
    return unsubscribe
  },

  restartAndInstall: async () => {
    if (get().acting) return
    set({ acting: true })
    try {
      // For a staged update this quits the app, so nothing after it runs. For
      // the manual-download path it opens the release page and returns.
      await window.phosphor.invoke('updates:restartAndInstall')
    } finally {
      set({ acting: false })
    }
  },

  check: async () => {
    await window.phosphor.invoke('updates:check')
  },
}))

/** Whether the pill should render at all. */
export function isUpdateVisible(update: UpdateState): boolean {
  return (
    update.phase === 'downloading' ||
    update.phase === 'installing' ||
    update.phase === 'downloaded' ||
    update.phase === 'manual-download'
  )
}
