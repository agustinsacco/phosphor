import { create } from 'zustand'
import { DEFAULT_MODEL_PICKS, MAX_RECENT_MODELS, type ModelPicks } from '@shared/models'

/**
 * Starred and recently used models for the picker, keyed `provider/id`.
 *
 * A projection of `AppPrefs.modelPicks` like every other store here: writes go
 * to main immediately and the local copy is the optimistic echo, so starring a
 * model never waits on a round trip.
 *
 * The key is `provider/id`, never the id alone. "Claude Opus 5" is five
 * different rows in a catalogue that offers it natively, through the Claude
 * Code CLI, and through three Bedrock inference profiles — starring one of
 * those is a statement about the route, not just the model.
 */
interface ModelPicksState extends ModelPicks {
  /** False until prefs have been read, so the menu can avoid a starred-section flash. */
  hydrated: boolean
  hydrate: () => Promise<void>
  toggleStarred: (key: string) => void
  setGroupMode: (mode: ModelPicks['groupMode']) => void
  /** Record a pick. Called on every model change, including from the home screen. */
  recordUse: (key: string) => void
}

export const useModelPicksStore = create<ModelPicksState>((set, get) => ({
  starred: [],
  recent: [],
  groupMode: DEFAULT_MODEL_PICKS.groupMode,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    const prefs = await window.phosphor.invoke('app:getPrefs')
    const picks = prefs.modelPicks
    set({
      starred: picks?.starred ?? [],
      recent: picks?.recent ?? [],
      groupMode: picks?.groupMode ?? DEFAULT_MODEL_PICKS.groupMode,
      hydrated: true,
    })
  },

  toggleStarred: (key) => {
    const { starred } = get()
    const next = starred.includes(key) ? starred.filter((k) => k !== key) : [...starred, key]
    set({ starred: next })
    persist(get())
  },

  setGroupMode: (mode) => {
    if (get().groupMode === mode) return
    set({ groupMode: mode })
    persist(get())
  },

  recordUse: (key) => {
    const { recent } = get()
    const next = [key, ...recent.filter((k) => k !== key)].slice(0, MAX_RECENT_MODELS)
    // Same list, same order: skip the IPC round trip on the common case of
    // re-picking the model that is already most recent.
    if (next.length === recent.length && next.every((k, i) => k === recent[i])) return
    set({ recent: next })
    persist(get())
  },
}))

/** Write the durable slice only — `hydrated` and the actions are local state. */
function persist({ starred, recent, groupMode }: ModelPicks): void {
  void window.phosphor.invoke('app:setModelPicks', { starred, recent, groupMode })
}
