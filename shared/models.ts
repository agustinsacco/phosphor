/** App-level domain types shared between main and renderer. */
import { type ExtensionUIRequest, type PiEvent } from './rpc'

export interface PiHealth {
  ok: boolean
  /** Absolute path to the pi binary, when found. */
  binaryPath?: string
  /** Reported `pi --version`, when runnable. */
  version?: string
  /** Minimum version pidex supports. */
  minVersion: string
  reason?: 'not-found' | 'version-check-failed' | 'too-old'
  message?: string
}

export interface WorkspaceInfo {
  /** Absolute folder path. Doubles as the workspace id. */
  path: string
  name: string
  lastOpenedAt: number
}

/**
 * A `<userData>/sandboxes/sandbox-N` folder — the "No folder" scratch space.
 * A sandbox is an ordinary workspace once opened; this is the extra state
 * Settings needs to say whether one is still worth keeping.
 */
export interface SandboxInfo {
  path: string
  name: string
  /** Entries the model wrote, dotfiles excluded. 0 means untouched. */
  itemCount: number
  /** Folder mtime — when something was last added to or removed from it. */
  lastUsedAt: number
}

/** Options for creating/attaching a live pi session (subprocess). */
export interface CreateSessionOptions {
  workspacePath: string
  /** Resume an existing session file. */
  sessionPath?: string
  /** Fork from an existing session file/id. */
  forkFrom?: string
  /** Display name for new sessions. */
  name?: string
  model?: string
  provider?: string
  thinkingLevel?: string
}

/** A live session handle as reported by main. */
export interface LiveSessionInfo {
  /** pidex-side id used for IPC channels (not pi's session id). */
  sessionId: string
  workspacePath: string
  pid?: number
}

/** Pushed on the per-session event channel. */
export type SessionPush =
  | { kind: 'event'; event: PiEvent }
  | { kind: 'extension-ui'; request: ExtensionUIRequest }
  | { kind: 'stderr'; text: string }
  | { kind: 'exit'; code: number | null; signal: string | null; expected: boolean }

/** Parsed metadata for one on-disk session file (sidebar row + stats). */
export interface SessionMeta {
  path: string
  sessionId: string
  cwd: string
  createdAt: string
  parentSession?: string
  /** Id of the first entry after the header; see `dropSupersededSessions`. */
  firstEntryId?: string
  name?: string
  firstUserText?: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  entryCount: number
  branchCount: number
  mtimeMs: number
  lastActivityAt: string
}

/**
 * Latest attempt to scan a workspace's session directory.
 *
 * Absent = never attempted. `ok` = the newest `sessions:list` resolved
 * (possibly to zero sessions); `error` = the newest attempt threw, so the
 * sidebar must not claim the folder is empty.
 */
export type SessionScanStatus = 'ok' | 'error'

export interface WorkspaceSessionStats {
  sessionCount: number
  messages: number
  tokens: number
  cost: number
  activeDays: number
  /** ISO day (YYYY-MM-DD) → activity count. */
  activityByDay: Record<string, number>
}

export interface GitInfo {
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  dirtyCount?: number
  /** True when the cwd is a linked git worktree (git-dir ≠ common-dir). */
  isWorktree?: boolean
  /** The main repository's working directory, when this is a worktree. */
  mainRepoPath?: string
}

/** One entry from `git worktree list`, enriched with dirty state. */
export interface WorktreeInfo {
  /** Path as git recorded it at `worktree add` time. */
  path: string
  /** `realpathSync.native`-resolved path — matches session cwds. */
  realPath: string
  branch: string | null
  head: string
  isMain: boolean
  locked: boolean
  prunable: boolean
  /** `git status --porcelain` line count; −1 when the dir is missing. */
  dirtyCount: number
}

export interface BranchInfo {
  name: string
  isCurrent: boolean
  /** Worktree that has this branch checked out, if any. */
  worktreePath?: string
  lastCommitSubject?: string
  lastCommitAt?: number
  /** Upstream ref (`origin/main`), absent when the branch never had one. */
  upstream?: string
  /** Commits this branch has that its upstream does not. */
  ahead?: number
  /** Commits the upstream has that this branch does not — "out of date". */
  behind?: number
  /**
   * Commits the repo's default branch has that this one does not. Absent when
   * git is too old for `%(ahead-behind:)` (< 2.41), which the UI treats the
   * same as "unknown", never as zero.
   */
  behindDefault?: number
}

export type AddWorktreeBranch =
  | {
      kind: 'new'
      base: string
      /**
       * Branch to create, when it must differ from the worktree folder name.
       * Auto-created session branches carry a configurable prefix (`pidex/…`)
       * that cannot appear in the folder name — the folder's basename is what
       * names the sidebar group, and a `/` in it would nest the checkout.
       * Absent means "same as the folder name", the hand-created case.
       */
      branch?: string
      /**
       * Skip `git`'s automatic upstream setup. Set when `base` is a
       * remote-tracking ref: without it the new branch would take `origin/main`
       * as its upstream, so its ahead/behind counts would be measured against
       * trunk and a stray `git push` would aim at main.
       */
      noTrack?: boolean
    }
  | { kind: 'existing'; branch: string }

/**
 * Where a new session branch should start from: the freshest trunk this repo
 * can offer without touching the main tree's checkout.
 */
export interface StartPoint {
  /** Ref to branch from — `origin/main` when fetched, else local `main`. */
  base: string
  /** Trunk's local branch name (`main`, `master`, …). */
  defaultBranch: string
  /** True when `base` is a remote-tracking ref (implies `noTrack` on create). */
  fromRemote: boolean
}

/** `git fetch --prune`, which is allowed to be a no-op or to fail quietly. */
export type FetchResult =
  | { fetched: true; at: number }
  /** Skipped: a fetch for this repo already ran inside the throttle window. */
  | { fetched: false; reason: 'throttled'; at: number }
  /** Offline, no remote, or no credentials — all ordinary, never an error. */
  | { fetched: false; reason: 'failed'; message: string }

/** Fast-forward-only pull. Never writes a merge commit, never conflicts. */
export type PullResult =
  | { pulled: true; upstream: string; commits: number }
  | { pulled: false; reason: 'up-to-date'; upstream: string }
  | { pulled: false; reason: 'no-upstream' }
  | { pulled: false; reason: 'diverged'; upstream: string; ahead: number; behind: number }
  | { pulled: false; reason: 'dirty'; dirtyCount: number }

/** Merging trunk into a worktree branch. Conflicts abort, never linger. */
export type UpdateFromMainResult =
  | { updated: true; commits: number; sha: string }
  | { updated: false; reason: 'up-to-date' }
  | { updated: false; reason: 'dirty'; dirtyCount: number }
  | { updated: false; reason: 'conflict'; conflicts: string[] }

/** Checking a branch out in a working tree, guarded on dirty/held. */
export type CheckoutResult =
  | { checkedOut: true; branch: string }
  | { checkedOut: false; reason: 'dirty'; dirtyCount: number }
  | { checkedOut: false; reason: 'held'; worktreePath: string }

/** Summary of a PR's status checks, from `gh` statusCheckRollup. */
export interface GhChecks {
  passed: number
  failed: number
  pending: number
  total: number
}

/**
 * A pull request for the current branch, as reported by the `gh` CLI.
 * Absent (null) whenever gh is missing, unauthenticated, or the repo has no
 * GitHub remote — all normal states, never surfaced as errors.
 */
export interface GhPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'DRAFT' | 'CLOSED' | 'MERGED'
  url: string
  mergeable?: string
  mergeStateStatus?: string
  checks?: GhChecks
  /**
   * Review verdict. Distinct from `checks`: a PR can be fully green and still
   * blocked on a human, which is a different action for the reader than a red
   * build, so the sidebar chip renders the two differently.
   */
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
}

export interface DirEntry {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
}

export interface FileContent {
  path: string
  content: string
  size: number
  mtimeMs: number
  tooLarge?: boolean
  binary?: boolean
}

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
   * Show each lane's GitHub PR status (open, checks, review, merged,
   * conflicts) in place of its session cost. Off reverts to cost, matching
   * pidex's behaviour before the PR chip existed.
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
   * Prepended to auto-generated branch names. `pidex/session-naming` keeps
   * generated branches sorted together and away from hand-made ones. Empty is
   * allowed and means "no prefix".
   */
  branchPrefix: string
}

export const DEFAULT_WORKTREE_PREFS: WorktreePrefs = {
  auto: true,
  branchPrefix: 'pidex/',
}
export interface AppPrefs {
  theme: ThemePreference
  recentWorkspaces: WorkspaceInfo[]
  /** Most recently used workspace — where the app lands with no session. */
  lastWorkspacePath?: string
  /**
   * Session file (.jsonl) that was open when the app last closed. Restored on
   * launch so pidex reopens where you left off rather than at the picker.
   */
  lastSessionPath?: string
  /** Pinned session file paths. */
  pinnedSessions: string[]
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
  /** What pidex appends to every lane's system prompt. */
  agentDirectives: AgentDirectivePrefs
  /** Per-project override of the above, keyed by main-repo path. */
  agentDirectivesByProject: Record<string, AgentDirectivePrefs>
  worktrees: WorktreePrefs
  /**
   * Claude Code auto-compact window for pi-claude-cli sessions, passed as
   * `PI_CLAUDE_CLI_AUTOCOMPACT` when a session spawns. Empty string means
   * "the provider's default" (200k as of pi-claude-cli 0.5.0). Other accepted
   * values mirror the provider: a window from 100k to 1M (`400k`, `400000`,
   * bare `400` = thousands), `auto` (the CLI's own default — effectively the
   * model's full 1M window), or `off` (omit the flag, for CLIs that predate
   * `--autocompact`). The provider validates again and falls back to its
   * default rather than passing a bad value to the CLI.
   */
  claudeAutocompact: string
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
   * Unsent composer drafts, keyed by `session:<pidexId>` or
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
  workspacePath?: string
  preferWorktree?: boolean
  updatedAt: number
}

/** Drafts kept per key; the oldest are pruned past this. */
export const MAX_DRAFTS = 30

/** Total bytes of draft image blobs allowed on disk. */
export const MAX_DRAFT_BLOB_BYTES = 50 * 1024 * 1024

/**
 * Layer 2 of the directive stack: what pidex appends to a lane's system
 * prompt. See `electron/pi/directives.ts` for the full stack and why this is
 * a setting rather than a constant.
 *
 * Global by default with a per-project override, because the right contents
 * depend on the repo AND on which model the lane runs: Anthropic's frontier
 * models now ship a system prompt roughly 70-80% shorter than the previous
 * generation, and a mixed fleet needs a lean profile and a fuller one.
 */
export interface AgentDirectivePrefs {
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

export const DEFAULT_CLAUDE_ACCOUNT_PREFS: ClaudeAccountPrefs = {
  accounts: [],
  mode: 'specific',
  cursor: 0,
  cooldowns: {},
  bindings: {},
}

export const DEFAULT_APP_PREFS: AppPrefs = {
  theme: 'dark',
  recentWorkspaces: [],
  pinnedSessions: [],
  modelPicks: DEFAULT_MODEL_PICKS,
  collapsedWorkspaces: [],
  seenSessions: {},
  laneMarkers: {},
  lanes: DEFAULT_LANE_PREFS,
  fonts: DEFAULT_FONT_PREFS,
  agentDirectives: DEFAULT_AGENT_DIRECTIVES,
  agentDirectivesByProject: {},
  worktrees: DEFAULT_WORKTREE_PREFS,
  claudeAutocompact: '',
  claudeAccounts: DEFAULT_CLAUDE_ACCOUNT_PREFS,
  drafts: {},
}

/** Minimum pi version pidex is verified against. */
export const MIN_PI_VERSION = '0.84.1'

/**
 * Health of one pi config file. `malformed` distinguishes "present but
 * unparseable" from "absent", which matters before writing: merging a patch
 * onto a failed read would silently discard the user's configuration.
 */
export interface ConfigFileHealth {
  exists: boolean
  malformed: boolean
  error?: string
}

/** Health of the global and per-project pi config files. */
export interface AgentSettingsHealth {
  global: ConfigFileHealth
  project: ConfigFileHealth | null
}

/** Runtime and version info for the About tab. */
export interface AboutInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
}

/** Native save-dialog options. */
export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

/** Local (non-package) resources discovered in pi's agent directory. */
export interface PiResources {
  skills: string[]
  extensions: string[]
  prompts: string[]
  themes: string[]
}

// ---------- pi packages ----------

/** Resources a pi package provides, by kind (file/dir names for display). */
export interface PiPackageResources {
  extensions: string[]
  skills: string[]
  prompts: string[]
  themes: string[]
}

/** One entry of a settings.json `packages` array, enriched from disk. */
export interface PiPackageEntry {
  /** The spec as written in settings (string form of the object form's `source`). */
  spec: string
  scope: 'global' | 'project'
  kind: 'npm' | 'git' | 'path'
  /** True when the settings entry is the object form with resource filters. */
  filtered: boolean
  /** Display name: npm package name, git repo, or path basename. */
  name: string
  version?: string
  description?: string
  /** Whether the resolved install directory exists on disk. */
  installed: boolean
  installPath?: string
  resources: PiPackageResources
}

export type PackageJobAction = 'install' | 'remove' | 'update'

/** Local `claude auth status` result (no network round-trip). */
export interface ClaudeAuthStatus {
  ok: boolean
  loggedIn?: boolean
  method?: string
  email?: string
  /** `subscriptionType`, e.g. `pro` / `max` / `team`. Which plan pays. */
  plan?: string
  /** `orgName` — present for team/enterprise logins, the giveaway for a wrong account. */
  organization?: string
  /** `orgId`. Pinned back onto a session as `CLAUDE_CODE_ORGANIZATION_UUID`. */
  orgId?: string
  error?: string
}

/** Claude Code CLI health for the provider tab. */
export interface ClaudeStatus {
  binary: { found: boolean; path?: string; version?: string }
  auth: ClaudeAuthStatus
}

/**
 * One plan-usage window, as the CLI renders it in `claude -p /usage`.
 *
 * The CLI prints Claude Desktop's own live numbers (fed by the internal
 * `/api/oauth/usage` endpoint) as text; these are the parsed windows of that
 * text. The percent is the server's own accounting — always visible, not
 * gated on any warning threshold like `rate_limit_event`'s `utilization`.
 */
export interface ClaudeUsageWindow {
  /** The CLI's rendered label, e.g. "Current session" (the 5-hour block). */
  label: string
  /** Window family, derived from the label; `other` for kinds pidex doesn't know. */
  kind: 'five_hour' | 'weekly' | 'weekly_model' | 'other'
  /** Fraction of the window consumed, 0–100 (the CLI prints whole percents). */
  percentUsed: number
  /** When the window resets, Unix ms; null when the reset didn't parse. */
  resetsAt: number | null
}

/** Result of one `claude -p /usage` run. */
export interface ClaudeUsageSnapshot {
  fetchedAt: number
  /** True when the CLI served its cache ("Showing last-known usage"). */
  stale: boolean
  windows: ClaudeUsageWindow[]
  /** The "What's contributing to your limits usage?" block, verbatim, when present. */
  contributing: string | null
}

// ---------- Claude Code accounts ----------

/**
 * One Claude Code login pidex can route a session to.
 *
 * Multiple accounts are possible because the CLI derives its keychain service
 * name from a config directory: `CLAUDE_SECURESTORAGE_CONFIG_DIR` appends a
 * hash of that directory to `Claude Code-credentials`, giving each account its
 * own credential while `~/.claude` (projects, settings, skills, plugins) stays
 * shared. Verified against Claude Code 2.1.260; see
 * docs/log/2026-09-04-claude-multi-account.md.
 */
export interface ClaudeAccount {
  /** Stable id; also the folder name under the accounts directory. */
  id: string
  /** What the UI shows. Defaults to the email the CLI reported at sign-in. */
  label: string
  email?: string
  /** `subscriptionType` at sign-in, e.g. `pro` / `max` / `team`. */
  plan?: string
  organization?: string
  /**
   * `orgId` at sign-in, passed back as `CLAUDE_CODE_ORGANIZATION_UUID`.
   *
   * `~/.claude.json`'s `oauthAccount` block is keyed by `CLAUDE_CONFIG_DIR`,
   * NOT by the securestorage dir, so all accounts share it and the last one to
   * sign in wins its org id. The CLI reads this env var ahead of that block,
   * which is what keeps a session's org matched to its token.
   */
  orgId?: string
  /**
   * Credential directory, or null for the CLI's own default keychain entry —
   * the one your terminal `claude` uses. The first account is seeded as null
   * so nothing has to migrate.
   */
  credentialDir: string | null
  addedAt: number
}

/** How a new session picks which account bills it. */
export type ClaudeRoutingMode = 'specific' | 'ordered' | 'round-robin'

/** Accounts, their order, and the routing rule over them. */
export interface ClaudeAccountPrefs {
  /** Ordered — `ordered` mode walks this top to bottom. */
  accounts: ClaudeAccount[]
  mode: ClaudeRoutingMode
  /** Which account `specific` mode uses. Falls back to the first. */
  pinnedId?: string
  /** Next index `round-robin` hands out. */
  cursor: number
  /**
   * Account id → epoch ms its 5-hour window resets, for accounts observed at
   * 100%. `ordered` and `round-robin` skip an account until then.
   */
  cooldowns: Record<string, number>
  /** Session file path → account id, so a resumed session keeps its billing. */
  bindings: Record<string, string>
}

/** An account plus the live facts the settings tab needs to render it. */
export interface ClaudeAccountView {
  account: ClaudeAccount
  auth: ClaudeAuthStatus
  /** Cached usage, when main has a fresh enough snapshot. Never fetched inline. */
  usage: ClaudeUsageSnapshot | null
  /** Cooldown expiry from `ClaudeAccountPrefs.cooldowns`, when active. */
  cooldownUntil: number | null
}

/** `claude:accounts` channel result. */
export interface ClaudeAccountsResult {
  prefs: ClaudeAccountPrefs
  views: ClaudeAccountView[]
}

/** Why a `claude -p /usage` run produced no windows. */
export type ClaudeUsageError = 'claude-not-found' | 'run-failed' | 'no-usage'

/** `claude:usageSnapshot` channel result. */
export type ClaudeUsageSnapshotResult =
  { ok: true; snapshot: ClaudeUsageSnapshot } | { ok: false; error: ClaudeUsageError }

/**
 * Where an in-app `claude auth login` has got to.
 *
 * Deliberately not `LoginFlowState`: this is a different flow with a different
 * shape. pi's OAuth providers hand off to a browser and finish by themselves,
 * while the Claude CLI's handshake redirects to a page that shows a code the
 * user must paste back — so `awaiting-code` is a state the UI must collect
 * input in, not just wait in. See `electron/pi/claude-login.ts`.
 */
export type ClaudeLoginState =
  | { phase: 'starting' }
  | {
      phase: 'awaiting-code'
      /** Authorization page. The CLI already opened it; this is the fallback link. */
      url: string
      /** The previous code was rejected and this URL is its replacement. */
      invalidCode?: boolean
    }
  /** Code submitted; waiting on the CLI to write credentials. */
  | { phase: 'finishing' }
  | { phase: 'signed-in'; email?: string }
  | { phase: 'cancelled' }
  | { phase: 'error'; message: string }

// ---------- subscription accounts ----------

/**
 * A provider pi can sign into with a consumer subscription rather than an
 * API key. The list is pidex's, not pi's: pi exposes no way to enumerate its
 * OAuth providers over RPC or the CLI, so these are curated from pi's
 * providers doc and each id is verified against `pi auth check`.
 */
/**
 * Providers pi offers under "Sign in with an account", as of pi 0.84.1.
 *
 * Read off pi's own login screen rather than guessed: pi exposes no way to
 * enumerate these (no CLI, no RPC, and the provider registry is not a package
 * export), so this list is maintained by hand and WILL drift as pi adds
 * providers. `pi auth check --provider <id>` answers `provider_not_found` for
 * an id pi does not know, which surfaces as "unknown" rather than a crash.
 */
export type LoginProviderId =
  | 'anthropic'
  | 'openai-codex'
  | 'github-copilot'
  | 'kimi-for-coding'
  | 'openrouter'
  | 'radius'
  | 'xai'

/** Where a sign-in has got to. Drives the whole Accounts UI. */
/**
 * Progress of a headless MCP connector authorization
 * (`electron/pi/connector-auth.ts`).
 *
 * Deliberately not `LoginFlowState`: this flow is owned by the MCP adapter
 * inside a throwaway pi process, and its only interactive step is a browser
 * round-trip whose fallback is pasting the callback URL back.
 */
export type ConnectorAuthState =
  | { phase: 'starting' }
  /** The adapter produced an authorization URL; main already opened it. */
  | { phase: 'awaiting-browser'; authorizationUrl: string }
  | { phase: 'connected' }
  | { phase: 'failed'; message: string }

/** One `mcp:authState` push. */
export interface ConnectorAuthPush {
  serverName: string
  state: ConnectorAuthState
}

export type LoginFlowState =
  | { providerId: LoginProviderId; phase: 'starting' }
  /** pi produced a device-code URL; the user finishes in their browser. */
  | {
      providerId: LoginProviderId
      phase: 'awaiting-browser'
      url: string
      /** Device code to type on the provider's page. */
      userCode?: string
    }
  | { providerId: LoginProviderId; phase: 'signed-in' }
  | { providerId: LoginProviderId; phase: 'cancelled' }
  | { providerId: LoginProviderId; phase: 'error'; message: string }

export interface SubscriptionProvider {
  /** pi's provider id — the key in `auth.json` and `pi auth check --provider`. */
  id: LoginProviderId
  name: string
  /** What the user must already be paying for. */
  requires: string
  /**
   * What signing in actually spends. The distinction matters enough to sort
   * the list by: a plan you already pay for is free to use here, while a
   * balance is charged per token even though the sign-in looks identical.
   */
  billing: 'subscription' | 'balance'
  /** Anything the user should know before signing in. Rendered verbatim. */
  caveat?: string
}

/**
 * One provider's readiness, straight from `pi auth check --json`.
 *
 * `status` is pi's own word. `unknown` is pidex's: it means the check could
 * not be run at all (pi missing, spawn failed, unparseable output), which is
 * deliberately distinct from pi answering "not_ready".
 */
export interface SubscriptionProviderStatus extends SubscriptionProvider {
  status: 'ready' | 'not_ready' | 'unknown'
  /** pi's machine-readable reason, e.g. `credentials_not_configured`. */
  reason?: string
  /** Present only when the check itself failed. */
  error?: string
}

// ---------- updater ----------

/**
 * Update lifecycle as the renderer sees it. Mirrors
 * `electron/updates/update-state.ts`, which owns the reducer.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  /** Verifying and expanding the download (macOS self-install only). */
  | 'installing'
  | 'downloaded'
  /** Detected, but this install must be updated by hand (unsigned mac, deb). */
  | 'manual-download'
  /** No update mechanism (dev / unpackaged). */
  | 'unsupported'

export interface UpdateState {
  phase: UpdatePhase
  version?: string
  progressPercent?: number
  releaseUrl?: string
}
