import { create } from 'zustand'

/**
 * The context budget (Settings → Agent → Context budget;
 * `AppPrefs.contextBudget`, grammar in `shared/context-budget.ts`).
 *
 * A leaf store for the same reason `lanePrefs.ts` is one: `stores/settings.ts`
 * calls `window.matchMedia` at creation, and the context meter — which reads
 * this to measure a session against the line it compacts at rather than the
 * model window — is covered by jsdom tests that must not drag that in.
 *
 * Hydrated from `app:getPrefs` by `settings.ts`, so there is still exactly one
 * prefs round-trip on launch; the settings tab updates it on save.
 *
 * Raw string, as stored. Sessions read it through `sessionContextBudget()`.
 * It is the CURRENT setting, which is also what main enforces: every session,
 * whatever its provider, is checked against the current value when its next
 * turn settles, so the meter and the compaction never disagree for long.
 */
interface ContextBudgetState {
  contextBudget: string
  applyContextBudget: (value: string | undefined) => void
}

export const useContextBudgetStore = create<ContextBudgetState>((set) => ({
  contextBudget: '',
  applyContextBudget: (value) => set({ contextBudget: (value ?? '').trim() }),
}))
