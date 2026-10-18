import { create } from 'zustand'
import {
  DEFAULT_CONTEXT_FILE_PREFS,
  normalizeContextFilePrefs,
  type ContextFileKind,
  type ContextFilePrefs,
} from '@shared/context-files'

/**
 * Whether new lanes send CLAUDE.md / AGENTS.md (`AppPrefs.contextFiles`).
 *
 * A leaf store for the same reason `contextBudgetPref.ts` is one: the
 * composers read it, and their jsdom tests must not drag in `settings.ts`.
 * Hydrated by `settings.ts` from the one `app:getPrefs` round-trip.
 */
interface ContextFilesPrefState {
  prefs: ContextFilePrefs
  apply: (prefs: unknown) => void
  /**
   * Set one kind for new lanes and, with a `sessionId`, for that running lane
   * too. Optimistic; the saved value comes back on failure.
   */
  set: (kind: ContextFileKind, included: boolean, sessionId?: string) => Promise<void>
}

export const useContextFilesPrefStore = create<ContextFilesPrefState>((set, get) => ({
  prefs: DEFAULT_CONTEXT_FILE_PREFS,
  apply: (prefs) => set({ prefs: normalizeContextFilePrefs(prefs) }),
  set: async (kind, included, sessionId) => {
    const before = get().prefs
    set({ prefs: { ...before, [kind]: included } })
    try {
      await window.phosphor.invoke('app:setContextFile', kind, included, sessionId)
    } catch (error) {
      set({ prefs: before })
      throw error
    }
  },
}))
