import { create } from 'zustand'
import {
  DEFAULT_WRITING_PREFS,
  isLearnablePrompt,
  normalizeWritingPrefs,
  type WritingPrefs,
} from '@shared/writing'
import { createPredictor, type Predictor } from '@/lib/writing/predictor'

/**
 * Settings → Writing, and the autocomplete model learned from sent prompts.
 *
 * A leaf store like `contextFilesPref.ts`: the composers read it, and their
 * jsdom tests must not drag in `settings.ts`. Hydrated by `settings.ts`.
 *
 * The prompts load once, when a composer mounts with autocomplete on. Until
 * they arrive `predict` answers null; `ready` flips when they do, so a
 * composer re-renders and shows its suggestion.
 */
interface WritingState {
  prefs: WritingPrefs
  /** Prompts learned so far, once loaded; null before. */
  learned: number | null
  /** True once the learned prompts are loaded into the predictor. */
  ready: boolean
  apply: (prefs: unknown) => void
  setPrefs: (patch: Partial<WritingPrefs>) => Promise<void>
  /** What to show after the caret; `text` is everything before it. Null while off. */
  predict: (text: string) => string | null
  /** Learn a prompt a composer just sent (and keep it, in main). */
  recordPrompt: (text: string) => void
  clearPrompts: () => Promise<void>
  /** Load the learned prompts if they are not loaded yet; resolves either way. */
  load: () => Promise<void>
}

let predictor: Predictor | null = null
let loading: Promise<void> | null = null

export const useWritingStore = create<WritingState>((set, get) => ({
  prefs: DEFAULT_WRITING_PREFS,
  learned: null,
  ready: false,

  apply: (prefs) => set({ prefs: normalizeWritingPrefs(prefs) }),

  setPrefs: async (patch) => {
    const before = get().prefs
    const next = { ...before, ...patch }
    set({ prefs: next })
    try {
      await window.phosphor.invoke('writing:setPrefs', next)
    } catch (error) {
      set({ prefs: before })
      throw error
    }
  },

  predict: (text) => {
    if (!get().prefs.autocomplete || !predictor) return null
    return predictor.predict(text)
  },

  recordPrompt: (text) => {
    if (!get().prefs.autocomplete || !isLearnablePrompt(text)) return
    predictor?.add(text.trim())
    const learned = get().learned
    if (learned !== null) set({ learned: learned + 1 })
    void window.phosphor.invoke('writing:recordPrompt', text).catch(() => {
      // Learning is best effort; a failed write must not reach the send path.
    })
  },

  clearPrompts: async () => {
    await window.phosphor.invoke('writing:clearPrompts')
    predictor = createPredictor()
    set({ learned: 0, ready: true })
  },

  load: () => {
    loading ??= window.phosphor
      .invoke('writing:prompts')
      .then((prompts) => {
        predictor = createPredictor(prompts)
        set({ learned: prompts.length, ready: true })
      })
      .catch(() => {
        // Retry on the next ask rather than never learning this launch.
        loading = null
      })
    return loading
  },
}))
