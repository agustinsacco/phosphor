import {
  DEFAULT_APP_PREFS,
  DEFAULT_FONT_PREFS,
  type AppPrefs,
  type FontPrefs,
  type ThemePreference,
  type ModelPicks,
} from '@phosphor/shared/models'

export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
const KEY = 'phosphor.web.appearance.v1'
export function createBrowserPreferences(storage?: PreferenceStorage) {
  const prefs: AppPrefs = structuredClone(DEFAULT_APP_PREFS)
  // Learning prompts and native background services are never enabled by browser defaults.
  prefs.writing = { spellcheck: true, autocomplete: false }
  try {
    const text = storage?.getItem(KEY)
    if (text && text.length < 4096) {
      const saved: unknown = JSON.parse(text)
      if (
        saved &&
        typeof saved === 'object' &&
        'theme' in saved &&
        ['light', 'dark', 'system'].includes(String(saved.theme))
      )
        prefs.theme = saved.theme as ThemePreference
    }
  } catch {
    /* Storage may be denied; preferences still work in memory. */
  }
  return {
    get: () => structuredClone(prefs),
    theme(theme: ThemePreference) {
      if (!['light', 'dark', 'system'].includes(theme)) throw new Error('Invalid theme.')
      prefs.theme = theme
      // Persist one allowlisted, nonsecret scalar, never a caller-supplied object.
      try {
        storage?.setItem(KEY, JSON.stringify({ theme }))
      } catch {
        /* Memory-only fallback. */
      }
    },
    fonts(fonts: FontPrefs) {
      // Font preferences are memory-only; use the shared defaults as the schema.
      for (const [key, value] of Object.entries(DEFAULT_FONT_PREFS)) {
        const proposed = fonts[key as keyof FontPrefs]
        if (
          typeof proposed !== typeof value ||
          (typeof proposed === 'number' &&
            (!Number.isFinite(proposed) || proposed < 0 || proposed > 100)) ||
          (typeof proposed === 'string' && proposed.length > 200)
        )
          throw new Error('Invalid font preferences.')
      }
      prefs.fonts = Object.fromEntries(
        Object.keys(DEFAULT_FONT_PREFS).map((key) => [key, fonts[key as keyof FontPrefs]]),
      ) as unknown as FontPrefs
    },
    models(value: ModelPicks) {
      if (
        !value ||
        !Array.isArray(value.starred) ||
        !Array.isArray(value.recent) ||
        [value.starred, value.recent].some(
          (list) => list.length > 100 || list.some((v) => typeof v !== 'string' || v.length > 300),
        )
      )
        throw new Error('Invalid model preferences.')
      if (!['family', 'provider'].includes(value.groupMode))
        throw new Error('Invalid model grouping.')
      prefs.modelPicks = {
        starred: [...value.starred],
        recent: value.recent.slice(0, 8),
        groupMode: value.groupMode,
      }
    },
    clearOwner() {
      prefs.modelPicks = structuredClone(DEFAULT_APP_PREFS.modelPicks)
    },
  }
}
