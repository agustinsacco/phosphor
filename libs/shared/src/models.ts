/** App-level domain types shared between main and renderer. */
import { DEFAULT_FEEDBACK_PREFS, type FeedbackPrefs } from './feedback'
import { DEFAULT_CONTEXT_FILE_PREFS, type ContextFilePrefs } from './context-files'
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from './voice'
import { DEFAULT_WRITING_PREFS, type WritingPrefs } from './writing'

import type { WorkspaceInfo } from './models/sessions'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS, type ClaudeAccountPrefs } from './models/providers'

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
   * is not a row trailer either way — see `sessionSubtitle.ts`.
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

/**
 * The periodic janitor. Lanes are cheap to create and nothing ever reclaimed
 * one, so a long-lived install accumulates a worktree (and its own
 * `node_modules`) per lane forever — measured at 9.1 GB across 70 worktrees on
 * one machine, 77% of it duplicated dependencies.
 *
 * Measuring and deleting are separate switches on purpose. A sweep ALWAYS
 * measures; only `reclaimMergedWorktrees` lets it delete, and it ships off.
 */
export interface MaintenancePrefs {
  /** Sweep periodically while the app is running. */
  enabled: boolean
  /** Minutes between sweeps. Clamped to a sane floor by the scheduler. */
  intervalMinutes: number
  /**
   * Delete the worktree of a lane whose branch already landed on the trunk.
   * Off by default: rebuilding a reclaimed lane costs a fresh `npm install`,
   * so this is the user's call, not ours.
   */
  reclaimMergedWorktrees: boolean
  /** Leave a merged lane alone until it has been untouched this long. */
  minAgeHours: number
}

export const DEFAULT_MAINTENANCE_PREFS: MaintenancePrefs = {
  enabled: true,
  intervalMinutes: 60,
  reclaimMergedWorktrees: false,
  minAgeHours: 24,
}

/** Why a worktree was NOT reclaimed. Makes a sweep auditable after the fact. */
export type ReclaimHoldReason =
  'main-checkout' | 'no-branch' | 'dirty' | 'in-use' | 'unmerged' | 'too-recent'

export interface ReclaimHold {
  path: string
  branch: string | null
  reason: ReclaimHoldReason
}

export interface ReclaimCandidate {
  path: string
  branch: string | null
  /** Disk size in bytes, or null where it could not be measured. */
  bytes: number | null
  reason: 'merged'
}

/** One sweep's findings. Produced whether or not anything was deleted. */
export interface MaintenanceReport {
  ranAt: number
  workspacePath: string
  worktreeCount: number
  candidates: ReclaimCandidate[]
  held: ReclaimHold[]
  /** Stale registrations `git worktree prune` dropped — never a real directory. */
  prunedRegistrations: string[]
  /** Directories actually deleted this sweep. Empty unless the pref is on. */
  reclaimed: { path: string; branch: string | null; bytes: number | null }[]
  reclaimableBytes: number
  reclaimedBytes: number
  /** Live `pi --mode rpc` children, each costing roughly 200 MB resident. */
  liveSessionCount: number
  errors: string[]
}

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
   * every other lane derives its marker from its branch (`lib/laneMarker.ts`),
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
   * `sessionContextBudget` in `shared/context-budget.ts`, enforced when a
   * turn settles by `electron/pi/context-budget.ts`. Empty string means the
   * default (200k). Other accepted values: a budget from 100k to 1M (`400k`,
   * `400000`, bare `400` = thousands), or `auto` / `off` for no budget, so
   * each session compacts only near its window. Stored as the Claude-only
   * `claudeAutocompact` until pi compacted every provider
   * (`electron/prefs-migrations.ts`).
   */
  contextBudget: string
  /**
   * Whether new lanes send the CLAUDE.md / AGENTS.md files pi finds. The
   * composer checkboxes write it; a running lane keeps its own state
   * (`shared/context-files.ts`).
   */
  contextFiles: ContextFilePrefs
  /** Spelling and autocomplete in Phosphor's text fields (`shared/writing.ts`). */
  writing: WritingPrefs
  /**
   * Set once the one-time check for a leftover `compaction.enabled: false` in
   * pi's global settings.json has run (`electron/pi/compaction-reset.ts`).
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

/** One pending attachment inside a persisted draft. */
export interface DraftAttachment {
  kind: 'image' | 'file'
  name: string
  size: number
  /** kind 'file': the absolute path the agent is told to open. */
  path?: string
  /** kind 'image': file under `userData/drafts/`. */
  blobId?: string
  mimeType?: string
}

/** A composer's unsent state, durable across session switches and restarts. */
export interface ComposerDraftRecord {
  key: string
  text: string
  attachments: DraftAttachment[]
  /**
   * The model chosen for THIS draft. The home picker also writes pi's global
   * default, but coming back to a draft should restore the model you picked
   * for it rather than whatever the last session set globally.
   */
  model?: { provider: string; id: string }
  thinking?: string
  /** Swarm choice for an unsent new lane, not a preference for later lanes. */
  swarm?: boolean
  workspacePath?: string
  preferWorktree?: boolean
  updatedAt: number
}

/** Drafts kept per key; the oldest are pruned past this. */
export const MAX_DRAFTS = 30

/** Total bytes of draft image blobs allowed on disk. */
export const MAX_DRAFT_BLOB_BYTES = 50 * 1024 * 1024

/**
 * Layer 2 of the directive stack: what Phosphor appends to a lane's system
 * prompt. See `electron/pi/directives.ts` for the full stack and why this is
 * a setting rather than a constant.
 *
 * Global by default with a per-project override, because the right contents
 * depend on the repo AND on which model the lane runs: Anthropic's frontier
 * models now ship a system prompt roughly 70-80% shorter than the previous
 * generation, and a mixed fleet needs a lean profile and a fuller one.
 */
export interface AgentDirectivePrefs {
  /** Machine-local context, fixed at spawn and shared by all providers. */
  machineAwareness: boolean
  /**
   * The worktree working-directory block. On by default and worth keeping:
   * it is the reason a whole class of confident wrong-branch answers stopped
   * (session 01a02ca0 read a copy 19 commits behind main and recommended
   * building a feature that already existed in its own worktree).
   */
  worktreeGuard: boolean
  /** The lane charter: this is a lane, it owns a branch, it ends in a PR. */
  laneCharter: boolean
  /**
   * The sub-agent policy block.
   *
   * On by default because the default is the unsafe one. A Claude Code
   * sub-agent launches in the BACKGROUND unless the caller passes
   * `run_in_background: false`, and the CLI is a per-turn model server that
   * exits when the turn's answer is done — so a backgrounded agent is killed
   * mid-flight and its findings never reach the model that asked for them.
   * Observed 2026-08-27: one lane launched five, they spawned two more, and
   * all seven died at the same millisecond having spent 28.6M tokens on work
   * nobody ever read. A synchronous sub-agent completes inside the turn and
   * returns normally (verified against `claude -p`), so this block asks for
   * the form that works rather than banning the tool.
   */
  subagentPolicy: boolean
  /** Free text appended last, so it can qualify either block above. */
  custom: string
}

export const DEFAULT_AGENT_DIRECTIVES: AgentDirectivePrefs = {
  machineAwareness: true,
  worktreeGuard: true,
  laneCharter: true,
  subagentPolicy: true,
  custom: '',
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

/**
 * Headroom tool-result compression. One flag on purpose: enabling it means
 * "manage the local proxy and compress eligible tool results in new
 * sessions"; everything else (adoption vs spawn, health, failure handling)
 * is the supervisor's job, not configuration.
 */
export interface HeadroomPrefs {
  enabled: boolean
}

export const DEFAULT_HEADROOM_PREFS: HeadroomPrefs = {
  // Off by default: turning it on is a ~500 MB install decision plus a local
  // service, and Phosphor never makes that decision silently.
  enabled: false,
}

/** State of the managed (or adopted) local Headroom proxy. */
export interface HeadroomStatus {
  enabled: boolean
  /** The `headroom` binary was found on the login-shell PATH. */
  installed: boolean
  version?: string
  binaryPath?: string
  proxy: {
    /** `GET /health` answered on the last probe. */
    running: boolean
    url: string
    /** Phosphor spawned this proxy (and will kill it on quit); false = adopted. */
    owned: boolean
  }
  /** Why the last start attempt failed, when it did. */
  error?: string
}

/** One Advisor recommendation. Advice only — Phosphor never acts on these. */
export interface AdvisorFinding {
  id: string
  severity: 'serious' | 'warning' | 'tip'
  title: string
  detail: string
  /** Settings tab that owns the fix, when one does. */
  settingsTab?: string
}

/** Per-lane compression savings for the Optimization tab. */
export interface LaneSavings {
  path: string
  name?: string
  firstUserText?: string
  savedTokens: number
  totalTokens: number
}

/** Read-only aggregate behind `optimization:stats`. */
export interface OptimizationStats {
  savedTokens: number
  sessionsWithSavings: number
  sessionCount: number
  /** Lanes with savings, largest first. */
  lanes: LaneSavings[]
  advisor: AdvisorFinding[]
}

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

export {
  type PiHealth,
  piInstallLocation,
  type WorkspaceInfo,
  type SandboxInfo,
  type CreateSessionOptions,
  type LiveSessionInfo,
  type SessionPush,
  type SessionMeta,
  type SessionScanStatus,
  type WorkspaceSessionStats,
  MIN_PI_VERSION,
  MIN_CLAUDE_CONTEXT_VERSION,
} from './models/sessions'
export {
  type GitInfo,
  type WorktreeInfo,
  type BranchInfo,
  type AddWorktreeBranch,
  type StartPoint,
  type FetchResult,
  type PullResult,
  type UpdateFromMainResult,
  type CheckoutResult,
  type GhChecks,
  type GhRepoPullRequests,
  type GhPullRequest,
} from './models/git'
export { type DirEntry, type FileContent, type OpenInDefaultAppResult } from './models/files'
export {
  type ConfigFileHealth,
  type AgentSettingsHealth,
  type AboutInfo,
  type SaveDialogOptions,
  type PiResources,
  type PiPackageResources,
  type PiPackageEntry,
  type PackageJobAction,
  type UpdatePhase,
  type UpdateState,
} from './models/platform'
export {
  DEFAULT_CLAUDE_ACCOUNT_PREFS,
  type ClaudeAuthStatus,
  type ClaudeStatus,
  type PlanUsageWindow,
  type ClaudeUsageWindow,
  type CodexUsageResult,
  type ClaudeUsageSnapshot,
  type ClaudeAccount,
  type ClaudeRoutingMode,
  type ClaudeAccountPrefs,
  type ClaudeAccountView,
  type ClaudeSessionAccount,
  type ClaudeAccountSessions,
  type ClaudeAccountsResult,
  type ClaudeUsageError,
  type ClaudeUsageSnapshotResult,
} from './models/providers'
export {
  type ClaudeLoginState,
  type LoginProviderId,
  type ConnectorAuthState,
  type ConnectorAuthPush,
  type LoginFlowState,
  type SubscriptionProvider,
  type SubscriptionProviderStatus,
} from './models/auth'
