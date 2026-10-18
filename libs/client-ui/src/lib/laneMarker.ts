/**
 * Lane markers — the emoji pinned left of a lane's title in the sidebar.
 *
 * Two rules make this work, and both are about the COLUMN rather than the
 * glyph:
 *
 * 1. Every lane has one. A slot that collapses when a lane has no marker
 *    shifts every title in the list and the left edge goes ragged, which is
 *    what stops the column being scannable. So an unassigned lane falls back
 *    to a hash of its branch — never to blank.
 * 2. The fallback is derived, not stored. Phosphor names a session only AFTER its
 *    first turn ends, so a brand-new lane has no name to key off; its branch
 *    exists from the moment the worktree does. That is why the hash keys on
 *    the branch (or cwd) and not on the title.
 *
 * Because the fallback is total, the stored override map is free to be pruned:
 * dropping an entry degrades a lane to its auto marker, never to nothing.
 */

/** Marker categories offered by the picker. */
export const MARKER_CATEGORIES: ReadonlyArray<{ name: string; markers: readonly string[] }> = [
  {
    name: 'Work',
    markers: [
      '🚀',
      '🔧',
      '🐛',
      '✨',
      '🎨',
      '📦',
      '🧪',
      '🔒',
      '⚡',
      '📝',
      '🏗️',
      '🧹',
      '🔥',
      '💡',
      '⚙️',
      '🩹',
      '🚧',
      '📊',
      '🧭',
      '🪝',
    ],
  },
  {
    name: 'Animals',
    markers: [
      '🦊',
      '🐙',
      '🐢',
      '🦉',
      '🐝',
      '🦁',
      '🐬',
      '🦋',
      '🐧',
      '🦆',
      '🐐',
      '🦄',
      '🐳',
      '🦔',
      '🦩',
      '🐊',
      '🦭',
      '🦇',
      '🐉',
      '🦥',
    ],
  },
  {
    name: 'Food',
    markers: [
      '🍎',
      '🍊',
      '🍋',
      '🍇',
      '🍓',
      '🥝',
      '🍑',
      '🍍',
      '🥑',
      '🌶️',
      '🍄',
      '🌰',
      '🥐',
      '🍕',
      '🍩',
      '🧁',
      '🍫',
      '🍒',
      '🥥',
      '🫐',
    ],
  },
  {
    name: 'Marks',
    markers: [
      '🔴',
      '🟠',
      '🟡',
      '🟢',
      '🔵',
      '🟣',
      '🟤',
      '🔶',
      '🔷',
      '⭐',
      '🌙',
      '☄️',
      '🌈',
      '⛰️',
      '🌊',
      '🍀',
      '🎲',
      '🧿',
      '🎯',
      '🧨',
    ],
  },
]

/**
 * The auto-assign palette.
 *
 * Chosen for SILHOUETTE contrast at 14px, not for meaning — at sidebar size a
 * lane is identified by shape and dominant colour, and several otherwise
 * distinct emoji collapse into the same small blob (notably on Linux, where
 * the fallback font differs). Deliberately smaller than the full picker set:
 * a wider auto palette increases collisions in the sizes people actually run
 * without making any single lane easier to recognise.
 */
export const AUTO_MARKERS: readonly string[] = [
  '🚀',
  '🦊',
  '🎨',
  '🧪',
  '⚡',
  '🔥',
  '📊',
  '🧹',
  '🐙',
  '🍊',
  '🦉',
  '🔧',
  '🐝',
  '🍇',
  '🦁',
  '🍄',
  '🧭',
  '🐬',
  '🌊',
  '🪝',
  '🦋',
  '🍩',
  '🐧',
  '⭐',
  '🌶️',
  '🦄',
  '🍀',
  '🐢',
  '🧨',
  '🥝',
  '🐳',
  '🎯',
  '🦆',
  '🧿',
  '🍫',
  '🌙',
  '🔒',
  '📦',
  '🐉',
  '🍒',
]

/** FNV-1a. Small, stable across runs and processes, and well spread for short strings. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The marker a lane gets with no explicit choice.
 *
 * Keyed on the branch when there is one, else the cwd — both are stable for
 * the life of the lane, which the title is not (the auto-namer rewrites it
 * after turn one, and a marker that changed when the name landed would defeat
 * the whole point).
 */
export function autoMarker(key: string | null | undefined): string {
  if (!key) return AUTO_MARKERS[0]!
  return AUTO_MARKERS[hash(key) % AUTO_MARKERS.length]!
}

/**
 * The marker to render: an explicit choice, else the derived one.
 *
 * An explicit empty string means "no marker, on purpose" and is honoured —
 * that is distinct from having no entry at all, which means "never chose".
 *
 * `mode` is the user preference (`LanePrefs.markers`):
 * - `auto`   derive one for lanes that never chose. The default.
 * - `manual` respect choices, derive nothing. Someone who wants markers only
 *            on the handful of lanes they care about gets a quiet sidebar.
 * - `off`    no marker at all. The caller drops the whole column, rather than
 *            rendering an empty one, so turning this off reclaims the width.
 */
export function laneMarker(
  explicit: string | undefined,
  branch: string | null | undefined,
  cwd: string | null | undefined,
  mode: 'auto' | 'manual' | 'off' = 'auto',
): string {
  if (mode === 'off') return ''
  if (explicit !== undefined) return explicit
  return mode === 'manual' ? '' : autoMarker(branch || cwd)
}

/** Every glyph the picker offers, flattened. */
export function allMarkers(): string[] {
  return MARKER_CATEGORIES.flatMap((c) => [...c.markers])
}
