import { create } from 'zustand'

export type SettingsTab =
  | 'appearance'
  | 'writing'
  | 'agent'
  | 'accounts'
  | 'extensions'
  | 'claude-provider'
  | 'web-access'
  | 'computer-use'
  | 'subagents'
  | 'connectors'
  | 'workspaces'
  | 'optimization'
  | 'voice'
  | 'advanced'
  | 'keybindings'
  | 'about'

interface SettingsUiState {
  open: boolean
  tab: SettingsTab
  /** The search field. Its terms are painted in the open tab while set. */
  query: string
  /** Results are listed in place of the tab; false once one is opened or a tab is picked. */
  listing: boolean
  /** A setting to scroll to and flash once its tab renders; a new object per request. */
  reveal: { title: string } | null
  setOpen: (open: boolean) => void
  setTab: (tab: SettingsTab) => void
  setQuery: (query: string) => void
  openResult: (tab: SettingsTab, title: string) => void
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
  query: '',
  listing: false,
  reveal: null,
  // Each opening starts unsearched; ⌘, while already open keeps the search.
  setOpen: (open) =>
    set((s) => (s.open === open ? {} : { open, query: '', listing: false, reveal: null })),
  setTab: (tab) => set({ tab, listing: false, reveal: null }),
  setQuery: (query) => set({ query, listing: query.trim() !== '' }),
  openResult: (tab, title) => set({ tab, listing: false, reveal: { title } }),
}))
