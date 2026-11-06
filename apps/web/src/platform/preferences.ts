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
const APPEARANCE_MAX_CHARS = 4095
/** Lane and branch prefs: device prefs that apply to every Host's lanes from this browser. */
const LANES_KEY = 'phosphor.web.lanes.v1'
/** The largest stored lane prefs record, and the longest branch prefix accepted. */
const LANES_MAX_CHARS = 2048
export const BRANCH_PREFIX_MAX = 64

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The JSON record stored under `key`; null when absent, larger than `maxChars`, unreadable or not a record. */
function storedRecord(
  storage: PreferenceStorage | undefined,
  key: string,
  maxChars: number,
): Record<string, unknown> | null {
  try {
    const text = storage?.getItem(key)
    const saved: unknown = text && text.length <= maxChars ? JSON.parse(text) : null
    return record(saved) ? saved : null
  } catch {
    /* Storage may be denied or hold an older shape; defaults still work. */
    return null
  }
}

/** Store an allowlisted record, never a caller-supplied object; memory-only when storage refuses. */
function saveRecord(
  storage: PreferenceStorage | undefined,
  key: string,
  value: Record<string, unknown>,
): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    /* Memory-only fallback. */
  }
}

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

/** The sidebar's lane order and collapsed groups: Host keys only, since a browser has no This Mac. */
const SIDEBAR_KEY = 'phosphor.web.sidebar.v1'
const SIDEBAR_MAX_CHARS = 512 * 1024
const SIDEBAR_MAX_ENTRIES = 500
const SIDEBAR_ENTRY_MAX = 512
type SidebarField = 'sessionOrder' | 'collapsedWorkspaces'

/** Bounded, unique `host:` keys; anything else is dropped, never normalized into another key. */
function sidebarKeys(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid sidebar preferences.')
  const keys = value.filter(
    (key): key is string =>
      typeof key === 'string' &&
      key.startsWith('host:') &&
      key.length <= SIDEBAR_ENTRY_MAX &&
      [...key].every((char) => char.charCodeAt(0) >= 0x20),
  )
  return [...new Set(keys)].slice(0, SIDEBAR_MAX_ENTRIES)
}

/** Restore the stored lane order and collapsed groups into `prefs`, and the setters that store them. */
function sidebarPreferences(prefs: AppPrefs, storage: PreferenceStorage | undefined) {
  const fields: SidebarField[] = ['sessionOrder', 'collapsedWorkspaces']
  const saved = storedRecord(storage, SIDEBAR_KEY, SIDEBAR_MAX_CHARS)
  for (const field of fields) {
    const value = saved?.[field]
    if (Array.isArray(value)) prefs[field] = sidebarKeys(value)
  }
  const save = () =>
    saveRecord(storage, SIDEBAR_KEY, {
      sessionOrder: prefs.sessionOrder,
      collapsedWorkspaces: prefs.collapsedWorkspaces,
    })
  const setter = (field: SidebarField) => (value: string[]) => {
    prefs[field] = sidebarKeys(value)
    save()
  }
  return {
    sessionOrder: setter('sessionOrder'),
    collapsedWorkspaces: setter('collapsedWorkspaces'),
    /** Another owner's arrangement is not this one's. */
    clearSidebar() {
      if (fields.every((field) => !prefs[field].length)) return
      for (const field of fields) prefs[field] = []
      save()
    },
  }
}

/** Restore the stored lane and branch prefs into `prefs`, and the setters that store them. */
function lanePreferences(prefs: AppPrefs, storage: PreferenceStorage | undefined) {
  const saved = storedRecord(storage, LANES_KEY, LANES_MAX_CHARS)
  try {
    if (saved?.lanes !== undefined) prefs.lanes = laneRecord(saved.lanes)
    if (saved?.worktrees !== undefined) prefs.worktrees = worktreeRecord(saved.worktrees)
  } catch {
    /* An older shape; defaults still work. */
  }
  const save = () =>
    saveRecord(storage, LANES_KEY, { lanes: prefs.lanes, worktrees: prefs.worktrees })
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
  const theme = String(storedRecord(storage, KEY, APPEARANCE_MAX_CHARS)?.theme)
  if (['light', 'dark', 'system'].includes(theme)) prefs.theme = theme as ThemePreference
  const sidebar = sidebarPreferences(prefs, storage)
  return {
    ...lanePreferences(prefs, storage),
    sessionOrder: sidebar.sessionOrder,
    collapsedWorkspaces: sidebar.collapsedWorkspaces,
    get: () => structuredClone(prefs),
    theme(theme: ThemePreference) {
      if (!['light', 'dark', 'system'].includes(theme)) throw new Error('Invalid theme.')
      prefs.theme = theme
      // One allowlisted, nonsecret scalar.
      saveRecord(storage, KEY, { theme })
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
      sidebar.clearSidebar()
    },
  }
}
