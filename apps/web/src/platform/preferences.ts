import {
  DEFAULT_APP_PREFS,
  DEFAULT_FONT_PREFS,
  normalizeLanePrefs,
  type AppPrefs,
  type FontPrefs,
  type LanePrefs,
  type ThemePreference,
  type ModelPicks,
  type WorktreePrefs,
} from '@phosphor/shared/models'

export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
const KEY = 'phosphor.web.appearance.v1'
/** Lane and branch prefs: device prefs that apply to every Host's lanes from this browser. */
const LANES_KEY = 'phosphor.web.lanes.v1'
/** The largest stored lane prefs record, and the longest branch prefix accepted. */
const LANES_MAX_CHARS = 2048
export const BRANCH_PREFIX_MAX = 64

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Only the shared lane fields, normalized as Desktop's store does. Throws on a non-record. */
function laneRecord(value: unknown): LanePrefs {
  if (!record(value)) throw new Error('Invalid lane preferences.')
  return normalizeLanePrefs(value as Partial<LanePrefs>)
}

/** `auto` and a short one-line branch prefix, nothing else. */
function worktreeRecord(value: unknown): WorktreePrefs {
  if (
    !record(value) ||
    typeof value.auto !== 'boolean' ||
    typeof value.branchPrefix !== 'string' ||
    value.branchPrefix.length > BRANCH_PREFIX_MAX ||
    [...value.branchPrefix].some((char) => char.charCodeAt(0) < 0x20)
  )
    throw new Error('Invalid branch preferences.')
  return { auto: value.auto, branchPrefix: value.branchPrefix }
}

/** Restore the stored lane and branch prefs into `prefs`, and the setters that store them. */
function lanePreferences(prefs: AppPrefs, storage: PreferenceStorage | undefined) {
  try {
    const text = storage?.getItem(LANES_KEY)
    const saved: unknown = text && text.length <= LANES_MAX_CHARS ? JSON.parse(text) : null
    if (record(saved) && saved.lanes !== undefined) prefs.lanes = laneRecord(saved.lanes)
    if (record(saved) && saved.worktrees !== undefined)
      prefs.worktrees = worktreeRecord(saved.worktrees)
  } catch {
    /* Storage may be denied or hold an older shape; defaults still work. */
  }
  const save = () => {
    // Persist the normalized, allowlisted records only, never a caller-supplied object.
    try {
      storage?.setItem(
        LANES_KEY,
        JSON.stringify({ lanes: prefs.lanes, worktrees: prefs.worktrees }),
      )
    } catch {
      /* Memory-only fallback. */
    }
  }
  return {
    lanes(value: LanePrefs) {
      prefs.lanes = laneRecord(value)
      save()
    },
    worktrees(value: WorktreePrefs) {
      prefs.worktrees = worktreeRecord(value)
      save()
    },
  }
}

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
    ...lanePreferences(prefs, storage),
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
