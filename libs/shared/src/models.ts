/** App-level domain declarations; import this facade from app code. */
export { piInstallLocation, MIN_PI_VERSION, MIN_CLAUDE_CONTEXT_VERSION } from './models/sessions'
export type {
  PiHealth,
  WorkspaceInfo,
  SandboxInfo,
  CreateSessionOptions,
  LiveSessionInfo,
  SessionPush,
  SessionMeta,
  SessionScanStatus,
  WorkspaceSessionStats,
} from './models/sessions'
export type {
  GitInfo,
  WorktreeInfo,
  BranchInfo,
  AddWorktreeBranch,
  StartPoint,
  FetchResult,
  PullResult,
  UpdateFromMainResult,
  CheckoutResult,
  GhChecks,
  GhRepoPullRequests,
  GhPullRequest,
} from './models/git'
export type { DirEntry, FileContent, OpenInDefaultAppResult } from './models/files'
export type {
  ConfigFileHealth,
  AgentSettingsHealth,
  AboutInfo,
  SaveDialogOptions,
  PiResources,
  PiPackageResources,
  PiPackageEntry,
  PackageJobAction,
  UpdatePhase,
  UpdateState,
} from './models/platform'
export { DEFAULT_CLAUDE_ACCOUNT_PREFS } from './models/providers'
export type {
  ClaudeAuthStatus,
  ClaudeStatus,
  PlanUsageWindow,
  ClaudeUsageWindow,
  CodexUsageResult,
  ClaudeUsageSnapshot,
  ClaudeAccount,
  ClaudeRoutingMode,
  ClaudeAccountPrefs,
  ClaudeAccountView,
  ClaudeSessionAccount,
  ClaudeAccountSessions,
  ClaudeAccountsResult,
  ClaudeUsageError,
  ClaudeUsageSnapshotResult,
} from './models/providers'
export type {
  ClaudeLoginState,
  LoginProviderId,
  ConnectorAuthState,
  ConnectorAuthPush,
  LoginFlowState,
  SubscriptionProvider,
  SubscriptionProviderStatus,
} from './models/auth'
export { UI_SCALE_MIN, UI_SCALE_MAX, clampUiScale, DEFAULT_FONT_PREFS } from './models/appearance'
export type { ThemePreference, FontPrefs } from './models/appearance'
export {
  LANE_PREF_LIMITS,
  DEFAULT_LANE_PREFS,
  normalizeLanePrefs,
  DEFAULT_WORKTREE_PREFS,
} from './models/lanes'
export type { LanePrefs, WorktreePrefs } from './models/lanes'
export { DEFAULT_MAINTENANCE_PREFS } from './models/maintenance'
export type {
  MaintenancePrefs,
  ReclaimHoldReason,
  ReclaimHold,
  ReclaimCandidate,
  MaintenanceReport,
} from './models/maintenance'
export { MAX_DRAFTS, MAX_DRAFT_BLOB_BYTES } from './models/drafts'
export type { DraftAttachment, ComposerDraftRecord } from './models/drafts'
export { DEFAULT_AGENT_DIRECTIVES } from './models/directives'
export type { AgentDirectivePrefs } from './models/directives'
export { DEFAULT_HEADROOM_PREFS } from './models/optimization'
export type {
  HeadroomPrefs,
  HeadroomStatus,
  AdvisorFinding,
  LaneSavings,
  OptimizationStats,
} from './models/optimization'
export { MAX_RECENT_MODELS, DEFAULT_MODEL_PICKS, DEFAULT_APP_PREFS } from './models/prefs'
export type { AppPrefs, ModelPicks } from './models/prefs'
