import { create } from 'zustand'
import type { ImageContent } from '@shared/rpc'

/**
 * What a rewind (or an extension's `set_editor_text`) hands back to the
 * composer. Images ride along because pi's `fork` reply carries only the
 * message's TEXT — anything the user attached would otherwise be dropped on
 * the floor, and a rewind whose whole point is "give me that message back to
 * resend" has to give back all of it.
 */
export interface ComposerPrefill {
  text: string
  images?: ImageContent[]
}

/** Cross-component chat UI state (fork picker, composer prefill, verbosity). */
interface ChatUiState {
  forkPickerFor: string | null
  prefill: Record<string, ComposerPrefill | undefined>
  /**
   * sessionId → "keep every activity group open" (⌃O, Claude Code's verbose
   * toggle). A master switch: while it is on it wins over a group's own
   * collapsed state, and turning it off hands control back to the group.
   */
  verbose: Record<string, boolean>
  openForkPicker: (sessionId: string) => void
  closeForkPicker: () => void
  setPrefill: (sessionId: string, text: string, images?: ImageContent[]) => void
  consumePrefill: (sessionId: string) => ComposerPrefill | undefined
  toggleVerbose: (sessionId: string) => void
}

export const useChatUiStore = create<ChatUiState>((set, get) => ({
  forkPickerFor: null,
  prefill: {},
  verbose: {},
  openForkPicker: (sessionId) => set({ forkPickerFor: sessionId }),
  closeForkPicker: () => set({ forkPickerFor: null }),
  setPrefill: (sessionId, text, images) =>
    set((s) => ({ prefill: { ...s.prefill, [sessionId]: { text, images } } })),
  consumePrefill: (sessionId) => {
    const entry = get().prefill[sessionId]
    if (entry !== undefined) {
      set((s) => ({ prefill: { ...s.prefill, [sessionId]: undefined } }))
    }
    return entry
  },
  toggleVerbose: (sessionId) =>
    set((s) => ({ verbose: { ...s.verbose, [sessionId]: !s.verbose[sessionId] } })),
}))
