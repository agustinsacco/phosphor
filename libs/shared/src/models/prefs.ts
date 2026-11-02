import { DEFAULT_FEEDBACK_PREFS, type FeedbackPrefs } from '../feedback'
import { DEFAULT_CONTEXT_FILE_PREFS, type ContextFilePrefs } from '../context-files'
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from '../voice'
import { DEFAULT_WRITING_PREFS, type WritingPrefs } from '../writing'
import type { WorkspaceInfo } from './sessions'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS, type ClaudeAccountPrefs } from './providers'
import { DEFAULT_FONT_PREFS, type FontPrefs, type ThemePreference } from './appearance'
import {
  DEFAULT_LANE_PREFS,
  DEFAULT_WORKTREE_PREFS,
  type LanePrefs,
  type WorktreePrefs,
} from './lanes'
import { DEFAULT_MAINTENANCE_PREFS, type MaintenancePrefs } from './maintenance'
import { DEFAULT_AGENT_DIRECTIVES, type AgentDirectivePrefs } from './directives'
import { DEFAULT_HEADROOM_PREFS, type HeadroomPrefs } from './optimization'
import type { ComposerDraftRecord } from './drafts'

export interface AppPrefs {
  theme: ThemePreference
  recentWorkspaces: WorkspaceInfo[]
  /** Most recently used workspace — where the app lands with no session. */
  lastWorkspacePath?: string
  /**
   * Session file (.jsonl) that was open when the app last closed. Restored on
   * launch so Phosphor reopens where you left off rather than at the picker.
   */
  lastSessionPath?: string
  /** Pinned session file paths. */
  pinnedSessions: string[]
  /**
   * Session FILE NAME a rewind replaced → the file name that replaced it.
   * Written only by a rewind (never a fork or clone); the sidebar folds the
   * old file away while its successor is on disk. Names, not paths, so a
   * folder rename cannot break it. Bounded in the store.
   */
  rewoundSessions: Record<string, string>
  /** Manual sidebar order by session file path; unseen paths stay newest-first. */
  sessionOrder: string[]
  /**
   * Model picker memory, keyed `provider/id` (the same identity the picker
   * uses — a model is only ever "the same" if the route to it is too).
   */
  modelPicks: ModelPicks
  /** Sidebar workspace groups the user collapsed, by workspace path. */
  collapsedWorkspaces: string[]
  /**
   * Session file path → epoch ms when the user last viewed it. Powers the
   * sidebar's "unseen activity" pill; pruned to a bounded size in the store.
   */
  seenSessions: Record<string, number>
  /**
   * Session file path → chosen lane marker. Only EXPLICIT choices are stored;
   * every other lane derives its marker from its branch (`apps/desktop/src/lib/laneMarker.ts`),
   * so this map stays small and is safe to prune. An empty string is a real
   * value meaning "no marker, on purpose".
   */
  laneMarkers: Record<string, string>
  /** How lanes name and brand themselves. See LanePrefs. */
  lanes: LanePrefs
  fonts: FontPrefs
  /** What Phosphor appends to every lane's system prompt. */
  agentDirectives: AgentDirectivePrefs
  /** Per-project override of the above, keyed by main-repo path. */
  agentDirectivesByProject: Record<string, AgentDirectivePrefs>
  /**
   * Free text Phosphor used to append to lanes ("Your own text"), which it no
   * longer sends: the global text moved into pi's global AGENTS.md. Kept here,
   * keyed by project path ('' for global text that could not be moved), until
   * the user dismisses it in Settings → Agent → Global instructions.
   */
  retiredDirectives: Record<string, string>
  worktrees: WorktreePrefs
  /** Periodic reclamation of dead lanes and their disk. */
  maintenance: MaintenancePrefs
  /** Headroom tool-result compression (Settings → Optimization). */
  headroom: HeadroomPrefs
  /** Dictation with a local speech model (Settings → Voice, docs/voice.md). */
  voice: VoicePrefs
  /** Rating/feedback state: launch count, the one-time nudge, the relay. */
  feedback: FeedbackPrefs
  /**
   * How large an interactive session may grow before pi compacts it: one
   * token count for every provider, Claude Code included (Settings → Agent →
   * Context budget). It holds a session whose model window is larger than
   * it; a smaller window keeps pi's own threshold. The rule is
   * `sessionContextBudget` in `libs/shared/src/context-budget.ts`, enforced when a
   * turn settles by `apps/desktop/electron/pi/context-budget.ts`. Empty string means the
   * default (200k). Other accepted values: a budget from 100k to 1M (`400k`,
   * `400000`, bare `400` = thousands), or `auto` / `off` for no budget, so
   * each session compacts only near its window. Stored as the Claude-only
   * `claudeAutocompact` until pi compacted every provider
   * (`apps/desktop/electron/prefs-migrations.ts`).
   */
  contextBudget: string
  /**
   * Whether new lanes send the CLAUDE.md / AGENTS.md files pi finds. The
   * composer checkboxes write it; a running lane keeps its own state
   * (`libs/shared/src/context-files.ts`).
   */
  contextFiles: ContextFilePrefs
  /** Spelling and autocomplete in Phosphor's text fields (`libs/shared/src/writing.ts`). */
  writing: WritingPrefs
  /**
   * Set once the one-time check for a leftover `compaction.enabled: false` in
   * pi's global settings.json has run (`apps/desktop/electron/pi/compaction-reset.ts`).
   * Optional and not handed to the renderer: nothing there reads it.
   */
  compactionResetChecked?: boolean
  /**
   * Claude Code logins, their order, and how sessions are routed to them.
   *
   * Optional because it is deliberately NOT part of what `app:getPrefs` hands
   * the renderer: it carries credential directory paths and a session→account
   * map that no renderer surface needs. The settings tab reads accounts over
   * `claude:accounts`, which returns live auth state with them. The key is
   * declared here only so main's electron-store stays typed.
   */
  claudeAccounts?: ClaudeAccountPrefs
  /**
   * Unsent composer drafts, keyed by `session:<phosphorId>` or
   * `home:<workspacePath>`.
   *
   * Both composers used to keep their text and pending attachments in local
   * `useState`, and `ChatView` is keyed on the active session id — so
   * switching session unmounted the subtree and threw the draft away with no
   * warning, and quitting did the same. Image BYTES are not in here: they go
   * to `userData/drafts/` and are referenced by `blobId`, because a 5 MB paste
   * re-serialised into config.json on every keystroke is not a pref, it is a
   * problem.
   */
  drafts: Record<string, ComposerDraftRecord>
}

/** Starred and recently used models, keyed `provider/id`, plus how to group them. */
export interface ModelPicks {
  /** User-ordered; these sort to the top of the picker. */
  starred: string[]
  /** Most-recent-first, bounded by {@link MAX_RECENT_MODELS}. */
  recent: string[]
  /**
   * Whether the idle picker buckets by model family ("which Opus 5?") or by
   * provider ("what do I have from whom?"). Persisted because it is a habit,
   * not a per-open decision.
   */
  groupMode: 'family' | 'provider'
}

/**
 * How many recent models to remember. Long enough to cover the handful anyone
 * rotates between, short enough that the "Recent" section stays a shortcut
 * rather than a second copy of the catalogue.
 */
export const MAX_RECENT_MODELS = 8

export const DEFAULT_MODEL_PICKS: ModelPicks = { starred: [], recent: [], groupMode: 'family' }

export const DEFAULT_APP_PREFS: AppPrefs = {
  theme: 'dark',
  recentWorkspaces: [],
  pinnedSessions: [],
  rewoundSessions: {},
  sessionOrder: [],
  modelPicks: DEFAULT_MODEL_PICKS,
  collapsedWorkspaces: [],
  seenSessions: {},
  laneMarkers: {},
  lanes: DEFAULT_LANE_PREFS,
  fonts: DEFAULT_FONT_PREFS,
  agentDirectives: DEFAULT_AGENT_DIRECTIVES,
  agentDirectivesByProject: {},
  retiredDirectives: {},
  worktrees: DEFAULT_WORKTREE_PREFS,
  maintenance: DEFAULT_MAINTENANCE_PREFS,
  headroom: DEFAULT_HEADROOM_PREFS,
  voice: DEFAULT_VOICE_PREFS,
  feedback: DEFAULT_FEEDBACK_PREFS,
  contextBudget: '',
  contextFiles: DEFAULT_CONTEXT_FILE_PREFS,
  writing: DEFAULT_WRITING_PREFS,
  claudeAccounts: DEFAULT_CLAUDE_ACCOUNT_PREFS,
  drafts: {},
}
