import { create } from 'zustand'
import type { DraftKey } from './drafts'

/**
 * Window-local claims survive Home unmounting when a newly created lane is adopted.
 * So does why the last submission failed: the composer that sent it was replaced
 * by the starting echo, and the one that comes back must still say why.
 */
export const useHomeSubmissionsStore = create<{
  pending: Record<DraftKey, boolean>
  warnings: Record<DraftKey, string>
  begin: (key: DraftKey) => boolean
  finish: (key: DraftKey) => void
  warn: (key: DraftKey, message: string | null) => void
}>((set, get) => ({
  pending: {},
  warnings: {},
  warn(key, message) {
    set((s) => {
      const warnings = { ...s.warnings }
      if (message === null) delete warnings[key]
      else warnings[key] = message
      return { warnings }
    })
  },
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
