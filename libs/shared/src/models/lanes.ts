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
  /** Word range the namer is asked for. */
  nameMinWords: number
  nameMaxWords: number
  /** Hard cap on the generated title, applied after the model replies. */
  nameMaxLength: number
  /**
   * Hard cap on the branch/folder slug. Separate from `nameMaxLength`: a title
   * is read in a sidebar, a slug is read in `git branch` output and in a path.
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
  nameWords: { min: 1, max: 12 },
  nameMaxLength: { min: 16, max: 120 },
  branchSlugMaxLength: { min: 12, max: 80 },
} as const

export const DEFAULT_LANE_PREFS: LanePrefs = {
  markers: 'auto',
  autoName: true,
  nameMinWords: 2,
  nameMaxWords: 5,
  nameMaxLength: 60,
  branchSlugMaxLength: 40,
  prStatus: true,
}

/**
 * Clamp anything read off disk or sent over IPC.
 *
 * Prefs are user-editable JSON, and every one of these numbers ends up in a
 * prompt, a git ref or a path. A negative or absurd value must not reach any
 * of those.
 */
export function normalizeLanePrefs(input: Partial<LanePrefs> | undefined): LanePrefs {
  const merged = { ...DEFAULT_LANE_PREFS, ...input }
  const clamp = (value: number, lo: number, hi: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : fallback
  const minWords = clamp(
    merged.nameMinWords,
    LANE_PREF_LIMITS.nameWords.min,
    LANE_PREF_LIMITS.nameWords.max,
    DEFAULT_LANE_PREFS.nameMinWords,
  )
  return {
    markers: (['auto', 'manual', 'off'] as const).includes(merged.markers)
      ? merged.markers
      : DEFAULT_LANE_PREFS.markers,
    autoName: Boolean(merged.autoName),
    nameMinWords: minWords,
    // Never let max fall below min, or the prompt asks for "5-2 words".
    nameMaxWords: Math.max(
      minWords,
      clamp(
        merged.nameMaxWords,
        LANE_PREF_LIMITS.nameWords.min,
        LANE_PREF_LIMITS.nameWords.max,
        DEFAULT_LANE_PREFS.nameMaxWords,
      ),
    ),
    nameMaxLength: clamp(
      merged.nameMaxLength,
      LANE_PREF_LIMITS.nameMaxLength.min,
      LANE_PREF_LIMITS.nameMaxLength.max,
      DEFAULT_LANE_PREFS.nameMaxLength,
    ),
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
