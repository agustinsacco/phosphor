import { create } from 'zustand'

export type SettingsTab =
  | 'appearance'
  | 'agent'
  | 'accounts'
  | 'extensions'
  | 'claude-provider'
  | 'web-access'
  | 'computer-use'
  | 'connectors'
  | 'workspaces'
  | 'optimization'
  | 'advanced'
  | 'keybindings'
  | 'about'

interface SettingsUiState {
  open: boolean
  tab: SettingsTab
  setOpen: (open: boolean) => void
  setTab: (tab: SettingsTab) => void
}

/**
 * Open/close state for the settings modal.
 *
 * Deliberately a separate module from `SettingsModal.tsx`: the command palette
 * and the global keyboard shortcuts only need to *open* settings, and importing
 * the component would drag Monaco (via the config-file editor) into their
 * bundles.
 */
export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  open: false,
  tab: 'appearance',
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
}))
