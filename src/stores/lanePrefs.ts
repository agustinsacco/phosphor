import { create } from 'zustand'
import { DEFAULT_LANE_PREFS, normalizeLanePrefs, type LanePrefs } from '@shared/models'

/**
 * How lanes name and brand themselves.
 *
 * A leaf store on purpose, and deliberately NOT part of `stores/settings.ts`:
 * that store calls `window.matchMedia` at creation time to track the system
 * colour scheme, so importing it from `stores/sessions.ts` broke every
 * non-jsdom suite that touches sessions. These prefs are read from the session
 * store, the sidebar and `startChat`, none of which should have to drag a DOM
 * dependency in behind them.
 *
 * Hydrated from `app:getPrefs` by `settings.ts` (which already makes that
 * call), so there is still exactly one prefs round-trip on launch.
 */
interface LanePrefsState {
  lanes: LanePrefs
  /** Merge a patch, clamp it, and persist. */
  setLanePrefs: (patch: Partial<LanePrefs>) => void
  /** Replace wholesale from a prefs payload. */
  applyLanePrefs: (lanes: Partial<LanePrefs> | undefined) => void
}

export const useLanePrefsStore = create<LanePrefsState>((set, get) => ({
  lanes: DEFAULT_LANE_PREFS,

  /**
   * Clamped here as well as in the main process. The settings UI reads back
   * the value it just wrote, so an out-of-range number typed into a field has
   * to be corrected locally too, or the field and the stored pref disagree
   * until the next reload.
   */
  setLanePrefs: (patch) => {
    const lanes = normalizeLanePrefs({ ...get().lanes, ...patch })
    set({ lanes })
    void window.phosphor.invoke('app:setLanePrefs', lanes)
  },

  applyLanePrefs: (lanes) => set({ lanes: normalizeLanePrefs(lanes) }),
}))

/** Non-reactive read, for call sites already using `getState()`. */
export function lanePrefs(): LanePrefs {
  return useLanePrefsStore.getState().lanes
}
