import { create } from 'zustand'
import type { DraftKey } from './drafts'

/**
 * Why a draft's last submission failed. `returnTo` names the Host of a start the
 * echo stood in for: the Home that comes back reopens that Host's composer and
 * focuses it once, then `settle` clears it.
 */
export interface HomeWarning {
  message: string
  returnTo?: string
}

/**
 * Window-local claims survive Home unmounting when a newly created lane is adopted.
 * So does why the last submission failed: the composer that sent it was replaced
 * by the starting echo, and the one that comes back must still say why.
 */
export const useHomeSubmissionsStore = create<{
  pending: Record<DraftKey, boolean>
  warnings: Record<DraftKey, HomeWarning>
  begin: (key: DraftKey) => boolean
  finish: (key: DraftKey) => void
  warn: (key: DraftKey, message: string | null, returnTo?: string) => void
  settle: (key: DraftKey) => void
}>((set, get) => ({
  pending: {},
  warnings: {},
  warn(key, message, returnTo) {
    set((s) => {
      const warnings = { ...s.warnings }
      if (message === null) delete warnings[key]
      else warnings[key] = returnTo === undefined ? { message } : { message, returnTo }
      return { warnings }
    })
  },
  settle(key) {
    const warning = get().warnings[key]
    if (warning?.returnTo !== undefined)
      set((s) => ({ warnings: { ...s.warnings, [key]: { message: warning.message } } }))
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
