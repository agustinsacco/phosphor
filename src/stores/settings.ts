import { create } from 'zustand'
import { DEFAULT_FONT_PREFS, type FontPrefs, type ThemePreference } from '@shared/models'
import { useLanePrefsStore } from './lanePrefs'

interface SettingsState {
  theme: ThemePreference
  resolvedTheme: 'light' | 'dark'
  /** From pi's settings.json — hide thinking blocks in chat. */
  hideThinkingBlock: boolean
  fonts: FontPrefs
  setTheme: (theme: ThemePreference) => void
  setFonts: (fonts: Partial<FontPrefs>) => void
  hydrate: () => Promise<void>
  loadAgentSettings: (workspacePath?: string) => Promise<void>
}

function applyFontsToDom(fonts: FontPrefs): void {
  const root = document.documentElement
  // `uiScale` is deliberately absent here: it is applied as Chromium page zoom
  // by the main process (electron/window-chrome.ts). A root `font-size` only
  // moves `rem` lengths, and this UI pins nearly every glyph and icon in px,
  // so that version grew the padding and left the text alone. Setting both
  // would compound on the spacing.
  root.style.setProperty(
    '--px-font-mono',
    `'${fonts.monoFont}', ui-monospace, 'SF Mono', Menlo, Monaco, 'Cascadia Code', monospace`,
  )
  root.style.setProperty('--px-chat-font-size', `${fonts.chatFontSize}px`)
  root.style.setProperty('--px-editor-font-size', `${fonts.editorFontSize}px`)
  root.style.setProperty('--px-terminal-font-size', `${fonts.terminalFontSize}px`)
}

function resolve(theme: ThemePreference): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyToDom(resolved: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { theme } = get()
    if (theme === 'system') {
      const resolved = resolve(theme)
      applyToDom(resolved)
      set({ resolvedTheme: resolved })
    }
  })

  return {
    // Dark is the default (matches DEFAULT_APP_PREFS). A stored preference
    // replaces this on hydrate; preload applies the saved appearance to the
    // document before hydration, so these defaults do not decide first paint.
    theme: 'dark',
    resolvedTheme: resolve('dark'),
    hideThinkingBlock: false,
    fonts: DEFAULT_FONT_PREFS,

    loadAgentSettings: async (workspacePath) => {
      const settings = await window.phosphor.invoke('pi:agentSettings', workspacePath)
      set({ hideThinkingBlock: settings.hideThinkingBlock === true })
    },

    setTheme: (theme) => {
      const resolved = resolve(theme)
      applyToDom(resolved)
      set({ theme, resolvedTheme: resolved })
      void window.phosphor.invoke('app:setTheme', theme)
    },

    setFonts: (patch) => {
      const fonts = { ...get().fonts, ...patch }
      applyFontsToDom(fonts)
      set({ fonts })
      void window.phosphor.invoke('app:setFontPrefs', fonts)
    },

    hydrate: async () => {
      const prefs = await window.phosphor.invoke('app:getPrefs')
      const resolved = resolve(prefs.theme)
      applyToDom(resolved)
      applyFontsToDom(prefs.fonts)
      set({ theme: prefs.theme, resolvedTheme: resolved, fonts: prefs.fonts })
      // Lane prefs live in their own leaf store (no DOM dependency); this is
      // the one prefs round-trip, so it fills them too.
      useLanePrefsStore.getState().applyLanePrefs(prefs.lanes)
    },
  }
})
