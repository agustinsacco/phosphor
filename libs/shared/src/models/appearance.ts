export type ThemePreference = 'light' | 'dark' | 'system'

export interface FontPrefs {
  /** Page-zoom multiplier for the whole UI (1 = 100%). */
  uiScale: number
  chatFontSize: number
  editorFontSize: number
  terminalFontSize: number
  /** Mono family name; JetBrains Mono is bundled, other choices use local fonts. */
  monoFont: string
}

/**
 * UI-scale bounds. Shared so the settings field, the zoom shortcuts and the
 * main process that actually applies the zoom cannot drift apart.
 */
export const UI_SCALE_MIN = 0.7

export const UI_SCALE_MAX = 2

export function clampUiScale(factor: number): number {
  if (!Number.isFinite(factor)) return 1
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, factor))
}

export const DEFAULT_FONT_PREFS: FontPrefs = {
  uiScale: 1,
  chatFontSize: 14.5,
  editorFontSize: 12.5,
  terminalFontSize: 12.5,
  monoFont: 'JetBrains Mono',
}
