import { create } from 'zustand'
import type { FeedbackDraft, FeedbackState, FeedbackSubmitResult } from '@shared/feedback'

/**
 * Open/close state for the feedback form, plus the projection of main's
 * feedback state that decides whether the sidebar shows a nudge.
 *
 * Kept out of `FeedbackModal.tsx` for the same reason settings is: the sidebar
 * button and the command palette only need to open the form.
 */
interface FeedbackStoreState {
  open: boolean
  state: FeedbackState | null
  /** Set once a submit lands, so the form can say what happened. */
  sent: FeedbackSubmitResult | null
  submitting: boolean
  setOpen: (open: boolean) => void
  refresh: () => Promise<void>
  /** Record the one-time "not now" and drop the nudge immediately. */
  dismissNudge: () => Promise<void>
  submit: (draft: FeedbackDraft) => Promise<void>
}

export const useFeedbackStore = create<FeedbackStoreState>((set, get) => ({
  open: false,
  state: null,
  sent: null,
  submitting: false,

  setOpen: (open) => set(open ? { open, sent: null } : { open }),

  refresh: async () => {
    const state = await window.phosphor.invoke('feedback:state').catch(() => null)
    if (state) set({ state })
  },

  dismissNudge: async () => {
    const state = get().state
    if (state) set({ state: { ...state, nudge: false } })
    await window.phosphor.invoke('feedback:dismiss').catch(() => {})
  },

  submit: async (draft) => {
    if (get().submitting) return
    set({ submitting: true })
    try {
      const sent = await window.phosphor.invoke('feedback:submit', draft)
      set({ sent })
      // A success retires the nudge for good; main has already recorded it.
      if (sent.ok) await get().refresh()
    } catch {
      set({ sent: { ok: false, error: 'Could not send the feedback.' } })
    } finally {
      set({ submitting: false })
    }
  },
}))
