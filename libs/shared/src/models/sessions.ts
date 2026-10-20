import type { HostTarget } from '../remote-host'
import type { ExtensionUIRequest, PiEvent } from '../rpc'

export interface PiHealth {
  ok: boolean
  /**
   * What to spawn to run pi, when found. On macOS/Linux this is pi itself. On
   * Windows npm installs pi as a `.cmd` shim that Node refuses to spawn, so
   * this is `node.exe` and `prefixArgs` carries pi's entry script — every
   * spawn must put `prefixArgs` before pi's own arguments
   * (`apps/desktop/electron/pi/win-launch.ts`).
   */
  binaryPath?: string
  /** Arguments that go before pi's own. Empty except on Windows. */
  prefixArgs?: string[]
  /** Reported `pi --version`, when runnable. */
  version?: string
  /** Minimum version Phosphor supports. */
  minVersion: string
  reason?: 'not-found' | 'version-check-failed' | 'too-old'
  message?: string
}

/**
 * Where pi is installed, for display. `binaryPath` is `node.exe` on Windows,
 * which answers "what runs" but not "where is pi"; the entry script does.
 */
export function piInstallLocation(health: PiHealth): string | undefined {
  return health.prefixArgs?.[0] ?? health.binaryPath
}

export interface WorkspaceInfo {
  /** Absolute folder path. Doubles as the workspace id. */
  path: string
  name: string
  lastOpenedAt: number
}

/**
 * A `<userData>/sandboxes/<name>` folder — the "No folder" scratch space.
 * A sandbox is an ordinary workspace once opened; this is the extra state
 * Settings needs to say whether one is still worth keeping.
 */
export interface SandboxInfo {
  path: string
  /** The folder's basename: a minted `adjective-noun`, or whatever the user renamed it to. */
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
  /** phosphor-side id used for IPC channels (not pi's session id). */
  sessionId: string
  workspacePath: string
  pid?: number
  /** Known even when the transcript is missing or the process has crashed. */
  diskPath?: string
  /** Absent means this machine. A remote handle names its Host and lane (29). */
  target?: HostTarget
  laneId?: string
}

/** Pushed on the per-session event channel. */
export type SessionPush =
  | { kind: 'resync' }
  | { kind: 'event'; event: PiEvent }
  | { kind: 'extension-ui'; request: ExtensionUIRequest }
  | { kind: 'stderr'; text: string }
  | { kind: 'exit'; code: number | null; signal: string | null; expected: boolean }

/** Parsed metadata for one on-disk session file (sidebar row + stats). */
export interface SessionMeta {
  /** Explicit user completion, never inferred from Git or model output. */
  completedAt?: number
  worktreeRemoved?: boolean
  path: string
  sessionId: string
  cwd: string
  createdAt: string
  parentSession?: string
  /** Id of the first entry after the header, shared by forks that copy history. */
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
  /**
   * Tokens the bundled headroom extension removed from tool results before
   * the model saw them, summed from the `details.headroom` receipts it writes
   * into the session file. Zero for sessions that never compressed anything.
   */
  headroomSavedTokens: number
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
  /** Tokens saved by headroom compression across the workspace's sessions. */
  savedTokens: number
  activeDays: number
  /** ISO day (YYYY-MM-DD) → activity count. */
  activityByDay: Record<string, number>
}

/** Minimum pi version Phosphor is verified against. */
export const MIN_PI_VERSION = '1.2.0'

/**
 * The first `@saccolabs/pi-claude-cli` release a Claude session starts on.
 * 0.9.0 runs on pi's context alone; 0.10.0 sends pi's thinking level as pi
 * would (below it `off` still thinks and a level change restarts the CLI).
 * Main refuses anything older (`apps/desktop/electron/pi/provider-detect.ts`) and
 * Settings → Claude Code flags it.
 */
export const MIN_CLAUDE_CONTEXT_VERSION = '0.10.0'
