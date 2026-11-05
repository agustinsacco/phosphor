/**
 * How new chats relate to git branches.
 *
 * `auto` is the same switch the branch popup's "worktree" checkbox flips — one
 * persisted preference, not two that can disagree: it decides both whether
 * picking a branch isolates it and whether a new chat gets a branch of its own.
 */
/**
 * How a lane names itself, brands itself and slugs its branch.
 *
 * Split from `WorktreePrefs` on purpose: those two fields decide WHETHER a
 * chat gets a branch, while these decide what the resulting lane looks like.
 * A user who turns worktrees off still names sessions.
 */
export interface LanePrefs {
  /**
   * Emoji markers in the sidebar.
   * - `auto`   every lane has one; unset lanes derive theirs from the branch
   * - `manual` only lanes you explicitly chose a marker for
   * - `off`    no marker column at all
   */
  markers: 'auto' | 'manual' | 'off'
  /** Name a session from its first message. Off means it keeps that message. */
  autoName: boolean
  /**
   * Hard cap on the branch/folder slug. Separate from the title's fixed 60
   * characters: a title is read in a sidebar, a slug is read in `git branch`
   * output and in a path.
   */
  branchSlugMaxLength: number
  /**
   * Trail each lane with its GitHub PR status (open, checks, review, merged,
   * conflicts). Off leaves the row to its title, timestamp and branch; spend
   * is not a row trailer either way — see `apps/desktop/src/features/sessions/sessionSubtitle.ts`.
   */
  prStatus: boolean
}

/** Bounds the settings UI enforces, and the store clamps to. */
export const LANE_PREF_LIMITS = {
  branchSlugMaxLength: { min: 12, max: 80 },
} as const

export const DEFAULT_LANE_PREFS: LanePrefs = {
  markers: 'auto',
  autoName: true,
  branchSlugMaxLength: 40,
  prStatus: true,
}

/**
 * Clamp anything read off disk or sent over IPC.
 *
 * Prefs are user-editable JSON, and the slug length ends up in a git ref and
 * a path. A negative or absurd value must not reach either.
 */
export function normalizeLanePrefs(input: Partial<LanePrefs> | undefined): LanePrefs {
  const merged = { ...DEFAULT_LANE_PREFS, ...input }
  const clamp = (value: number, lo: number, hi: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : fallback
  return {
    markers: (['auto', 'manual', 'off'] as const).includes(merged.markers)
      ? merged.markers
      : DEFAULT_LANE_PREFS.markers,
    autoName: Boolean(merged.autoName),
    branchSlugMaxLength: clamp(
      merged.branchSlugMaxLength,
      LANE_PREF_LIMITS.branchSlugMaxLength.min,
      LANE_PREF_LIMITS.branchSlugMaxLength.max,
      DEFAULT_LANE_PREFS.branchSlugMaxLength,
    ),
    prStatus: Boolean(merged.prStatus),
  }
}

export interface WorktreePrefs {
  /** New chats start on their own branch in their own worktree. */
  auto: boolean
  /**
   * Prepended to auto-generated branch names. `phosphor/session-naming` keeps
   * generated branches sorted together and away from hand-made ones. Empty is
   * allowed and means "no prefix".
   */
  branchPrefix: string
}

export const DEFAULT_WORKTREE_PREFS: WorktreePrefs = {
  auto: true,
  branchPrefix: 'phosphor/',
}
