import { create } from 'zustand'
import type { VoicePrefs, VoiceStatus } from '@shared/voice'

/**
 * Voice prefs and model state, mirrored from main (`voice:statusChanged`).
 * Main owns the download and the files; this store records what it is told.
 */
interface VoiceStoreState {
  status: VoiceStatus | null
  /** Listen for changes and read the current state. Returns unsubscribe. */
  subscribe: () => () => void
  setPrefs: (prefs: VoicePrefs) => Promise<void>
}

export const useVoiceStore = create<VoiceStoreState>((set) => ({
  status: null,

  subscribe: () => {
    const off = window.phosphor.onVoiceStatus((status) => set({ status }))
    void window.phosphor
      .invoke('voice:status')
      .then((status) => set({ status }))
      .catch(() => undefined)
    return off
  },

  setPrefs: async (prefs) => {
    set({ status: await window.phosphor.invoke('voice:setPrefs', prefs) })
  },
}))

/** True when the composer should offer the microphone. */
export function useVoiceReady(): boolean {
  return useVoiceStore((s) => s.status?.prefs.enabled === true && s.status.phase === 'ready')
}
