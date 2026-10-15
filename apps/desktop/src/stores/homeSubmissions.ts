import { create } from 'zustand'
import type { DraftKey } from './drafts'

/** Window-local claims survive Home unmounting when a newly created lane is adopted. */
export const useHomeSubmissionsStore = create<{
  pending: Record<DraftKey, boolean>
  begin: (key: DraftKey) => boolean
  finish: (key: DraftKey) => void
}>((set, get) => ({
  pending: {},
  begin(key) {
    if (get().pending[key]) return false
    set((s) => ({ pending: { ...s.pending, [key]: true } }))
    return true
  },
  finish(key) {
    set((s) => {
      const pending = { ...s.pending }
      delete pending[key]
      return { pending }
    })
  },
}))
