import type { TailscaleStatus } from './tailscale-status'
import type { MachineModel, MachineProvider } from './host-protocol-machine'
import type { SshInstallEvent } from './ssh-install'
import type { HostCapability } from './remote-host'
import type { RepositorySummary, LaneSummary, StreamCursor } from './host-protocol'
/**
 * Typed IPC contract between main and renderer.
 *
 * Request/response methods use `ipcRenderer.invoke` on the channels in
 * `IpcInvokeMap`. Streams are pushed from main on per-session channels
 * (`pi:event:<sessionId>`) declared by `sessionEventChannel`.
 */
import type {
  RpcCommand,
  RpcResponse,
  ExtensionUIResponse,
  RpcResponseDataMap,
  RpcSlashCommand,
  ThinkingLevelMap,
  ModelCost,
} from './rpc'
import type { AccountView } from './account'
import type {
  ControlErrorCode,
  MachinesResponse,
  EnrollmentLookupResponse,
  EnrollmentApproveResponse,
} from './control-api'
import type { ArtifactListing, ArtifactSnapshot } from './artifacts'
import type { ContextFileKind } from './context-files'
import type { EditCommand, WritingPrefs } from './writing'
import type {
  RoutineCheck,
  RoutineInput,
  RoutineLaneIndex,
  RoutineRun,
  RoutinesSnapshot,
} from './routines'
import type {
  McpConfigsResult,
  McpListResult,
  McpMigrationPlan,
  McpMigrationResult,
  McpScope,
  McpServerConfig,
} from './mcp'
import type { SkillImportPreview, SkillScope, SkillsListResult } from './skills'
import type { WorkspaceSearchRequest, WorkspaceSearchResult } from './workspace-search'
import type { FeedbackDraft, FeedbackState, FeedbackSubmitResult } from './feedback'
import type { VoicePrefs, VoiceStatus } from './voice'
import type {
  AddWorktreeBranch,
  AppPrefs,
  MaintenancePrefs,
  MaintenanceReport,
  AboutInfo,
  AgentSettingsHealth,
  BranchInfo,
  CheckoutResult,
  ClaudeAccountSessions,
  ClaudeAccountsResult,
  ClaudeSessionAccount,
  ClaudeRoutingMode,
  ClaudeStatus,
  ClaudeUsageSnapshotResult,
  CodexUsageResult,
  ConnectorAuthPush,
  ClaudeLoginState,
  AgentDirectivePrefs,
  CreateSessionOptions,
  DirEntry,
  FetchResult,
  FileContent,
  OpenInDefaultAppResult,
  FontPrefs,
  PackageJobAction,
  PiPackageEntry,
  GhPullRequest,
  GhRepoPullRequests,
  GitInfo,
  HeadroomStatus,
  OptimizationStats,
  LiveSessionInfo,
  PiHealth,
  LoginFlowState,
  LoginProviderId,
  ModelPicks,
  SubscriptionProviderStatus,
  PiResources,
  PullResult,
  SandboxInfo,
  SaveDialogOptions,
  SessionMeta,
  SessionPush,
  StartPoint,
  UpdateFromMainResult,
  UpdateState,
  ThemePreference,
  WorkspaceInfo,
  WorkspaceSessionStats,
  WorktreeInfo,
  WorktreePrefs,
  ComposerDraftRecord,
  LanePrefs,
} from './models'

export type DesktopControlErrorCode = ControlErrorCode | 'signed-out' | 'offline'
export type ControlResult<T> =
  ({ ok: true } & T) | { ok: false; error: { code: DesktopControlErrorCode; message: string } }

/** Parsed session tree (subset of entries) for the tree view. */
export interface SessionTreeEntry {
  id: string
  parentId: string | null
  type: string
  timestamp: string
  role?: string
  preview?: string
  toolName?: string
  targetId?: string
  label?: string
  summary?: string
  name?: string
  /** model_change entries. */
  provider?: string
  modelId?: string
  /** thinking_level_change entries. */
  thinkingLevel?: string
}

export interface SessionTree {
  sessionId: string
  cwd: string
  entries: SessionTreeEntry[]
  leafId: string | null
}

export type HostLaneView = Omit<LaneSummary, 'control'> & {
  control: {
    fence: number
    controller: { label: string; connected: boolean; self: boolean } | null
  }
}

export interface HostConnectionView {
  /** Opaque main-owned transport incarnation, independent of the Host runtime epoch. */
  connectionToken: string
  state:
    | 'down'
    | 'no-address'
    | 'connecting'
    | 'ready'
    | 'reconnecting'
    | 'wrong-machine'
    | 'unsupported'
    | 'signed-out'
  hostVersion?: string
  capabilities: HostCapability[]
  repositories: RepositorySummary[]
  lanes: HostLaneView[]
  cursor?: StreamCursor
  lastError?: string
}
export type HostsSnapshot = Record<string, HostConnectionView>

/** A new lane on a Host (11). The Host picks the folder; never a path from here. */
export interface RemoteLaneCreate {
  repositoryId: string
  worktree?: { branch: string }
  name?: string
  provider?: string
  model?: string
  thinkingLevel?: string
}
/** An attention event from any Host, for in-app and OS notifications (49). */
export interface HostAttention {
  hostId: string
  laneId: string
  kind: 'finished' | 'needs-input' | 'failed' | 'routine'
  title: string
  at: string
}

export interface IpcInvokeMap {
  'hosts:tailscaleStatus': { args: []; result: TailscaleStatus }
  'hosts:setTailscaleDiscovery': { args: [enabled: boolean]; result: void }
  'hosts:sshInstall': { args: [target: string, repository?: string]; result: { jobId: string } }
  'hosts:sshInstallCancel': { args: [jobId: string]; result: void }
  // Read-only machine catalogues, independent of an open lane.
  'hosts:models': { args: [hostId: string]; result: MachineModel[] }
  'hosts:providers': { args: [hostId: string]; result: MachineProvider[] }
  'hosts:skills': { args: [hostId: string]; result: SkillsListResult }
  'hosts:providerLogin': { args: [hostId: string, provider: string]; result: { ptyId: string } }
  'hosts:uploadAttachments': {
    args: [sessionId: string, files: { name: string; mime: string; data: string }[]]
    result: string[]
  }
  'hosts:snapshot': { args: []; result: HostsSnapshot }
  'hosts:setFocusedLane': {
    args: [target: { hostId: string; laneId: string } | null]
    result: void
  }
  /** Opens a remote lane: returns an opaque handle (LiveSessionInfo.sessionId) whose
   * pi:command, pi:extensionUiResponse, pi:disposeSession and pi:event:<id> main routes
   * to the Host. Disposing a handle unsubscribes; it never stops the lane. */
  'hosts:openLane': { args: [hostId: string, laneId: string]; result: LiveSessionInfo }
  'hosts:createLane': { args: [hostId: string, input: RemoteLaneCreate]; result: LiveSessionInfo }
  'hosts:stopLane': { args: [hostId: string, laneId: string]; result: void }
  'hosts:resumeLane': { args: [hostId: string, laneId: string]; result: void }
  'hosts:takeControl': { args: [hostId: string, laneId: string]; result: void }
  'hosts:markRead': { args: [hostId: string, laneId: string]; result: void }
  'routines:list': { args: [machine?: string]; result: RoutinesSnapshot }
  'routines:save': {
    args: [
      input: RoutineInput & { repositoryId?: string },
      id?: string,
      revision?: number,
      machine?: string,
    ]
    result: void
  }
  'routines:check': { args: [input: RoutineInput]; result: RoutineCheck }
  'routines:history': { args: [routineId: string, offset: number]; result: RoutineRun[] }
  'routines:laneIndex': { args: []; result: RoutineLaneIndex }
  'routines:promoteRun': { args: [runId: string]; result: void }
  'routines:run': { args: [routineId: string, requestId: string]; result: RoutineRun }
  'routines:cancel': { args: [runId: string]; result: void }
  'routines:skipNext': { args: [routineId: string]; result: void }
  'routines:archive': { args: [routineId: string]; result: void }
  /** Removes the routine and its history; trashes lanes it still owns. */
  'routines:delete': { args: [routineId: string]; result: void }
  'routines:pauseAll': { args: [machine?: string]; result: void }
  'routines:background': { args: [enabled: boolean]; result: void }
  'pi:health': { args: []; result: PiHealth }
  'pi:createSession': { args: [CreateSessionOptions]; result: LiveSessionInfo }
  'pi:command': { args: [sessionId: string, command: RpcCommand]; result: RpcResponse }
  'pi:extensionUiResponse': {
    args: [sessionId: string, response: ExtensionUIResponse]
    result: void
  }
  'pi:disposeSession': { args: [sessionId: string]; result: void }
  /**
   * Live pi subprocesses main currently owns. A freshly loaded renderer calls
   * this to re-adopt sessions it orphaned (reload, crash) instead of leaving
   * ~200 MB processes stranded until quit — and to avoid spawning a SECOND
   * process for a session file an orphan still owns.
   */
  'pi:listLiveSessions': { args: []; result: LiveSessionInfo[] }
  /** One-shot `pi -p` completion that names a session after its first message. */
  'pi:generateTitle': {
    args: [workspacePath: string, message: string, existingNames: string[]]
    result: string | null
  }

  'app:getPrefs': { args: []; result: AppPrefs }
  'app:setTheme': { args: [ThemePreference]; result: void }
  'app:selectFolder': { args: []; result: string | null }
  /**
   * The "No folder" option: the `<userData>/sandboxes/<name>` folder a
   * project-less session should run in, randomly named `adjective-noun`. An
   * empty sandbox is reused; a fresh one is minted only when every existing
   * sandbox holds something. From then on it is an ordinary workspace
   * (recents, sessions, rename, removal).
   */
  'app:createSandbox': { args: []; result: string }
  /** Every sandbox on disk, most recently touched first (Settings lists it). */
  'app:listSandboxes': { args: []; result: SandboxInfo[] }
  /**
   * Rename a sandbox's folder, moving its transcripts with it and re-pointing
   * every stored path. Returns the new path — a sandbox IS its path, so the
   * caller has to re-point its own state too.
   *
   * Refused for a path that is not a sandbox, a name that cannot be a folder,
   * a name already taken, or a sandbox with a live session in it (its cwd
   * cannot move out from under a running pi).
   */
  'app:renameSandbox': {
    args: [path: string, name: string]
    result:
      | { ok: true; path: string }
      | {
          ok: false
          reason: 'not-a-sandbox' | 'invalid-name' | 'exists' | 'in-use' | 'failed'
        }
  }
  /**
   * Move one sandbox — folder and transcripts — to the Trash, and forget it.
   * Refused for a path that is not a sandbox, or one with a live session in
   * it; main re-derives what is legal rather than trusting the renderer.
   */
  'app:deleteSandbox': {
    args: [path: string]
    result: { ok: true } | { ok: false; reason: 'not-a-sandbox' | 'in-use' | 'failed' }
  }
  /**
   * Stage model-authored HTML for the artifact iframe and return a
   * `phosphor-artifact://` URL for it. The document is served on its own opaque
   * origin with `default-src 'none'`, which is what lets it run scripts
   * without the app's CSP — see electron/artifacts/artifact-protocol.ts.
   *
   * `theme` is the renderer's RESOLVED theme, and it is part of the staged
   * document (the house stylesheet is injected here, not written by the
   * model), so it must be passed on every call — not read from prefs in the
   * main process, or the caller has no dependency to re-stage on.
   */
  'artifacts:stageHtml': { args: [html: string, theme: 'light' | 'dark']; result: string }
  /**
   * Print an artifact's preview to a PDF in Downloads, and answer with where
   * it landed. `html` is what the preview renders — the raw markup for an HTML
   * artifact, the serialised preview DOM for the types the renderer draws
   * (markdown, mermaid, chart, code) — so the PDF goes through the same
   * staging path, and the same house sheet, as the iframe on screen.
   *
   * Rejects on failure rather than answering `null`: the caller has to have
   * something to show, or the button reads as broken.
   */
  'artifacts:exportPdf': {
    args: [{ html: string; title: string; theme: 'light' | 'dark' }]
    result: { savedTo: string }
  }
  /**
   * A session's artifacts from the store, as its pane shows them: each one's
   * versions on the current branch. Indexes the file first, so it is never
   * behind the session. This, not `get_messages`, is how a resumed pane is
   * filled: pi's messages stop at the last compaction.
   */
  'artifacts:forSession': { args: [sessionFile: string]; result: ArtifactSnapshot[] }
  /**
   * Every artifact in the store, newest first, for the global Artifacts page.
   * `livePaths` (open sessions' files) are indexed first so a turn that just
   * ended is listed.
   */
  'artifacts:list': { args: [livePaths: string[]]; result: ArtifactListing[] }
  /** One stored artifact with its content, for viewing outside its session. */
  'artifacts:read': {
    args: [key: string]
    result: { listing: ArtifactListing; artifact: ArtifactSnapshot } | null
  }
  /** Remove a deleted session's artifact. False (and nothing removed) otherwise. */
  'artifacts:remove': { args: [key: string]; result: boolean }
  'app:setPinnedSessions': { args: [string[]]; result: void }
  /** Replace the rewind record (AppPrefs.rewoundSessions); main bounds it. */
  'app:setRewoundSessions': { args: [Record<string, string>]; result: void }
  'app:setSessionOrder': { args: [string[]]; result: void }
  /** Explicit lane-marker choices, keyed by session file path. */
  'app:setLaneMarkers': { args: [Record<string, string>]; result: void }
  /** How lanes name and brand themselves; clamped in the main process. */
  'app:setLanePrefs': { args: [LanePrefs]; result: void }
  /** Model picker memory (pinned + recent), keyed `provider/id`. */
  'app:setModelPicks': { args: [ModelPicks]; result: void }
  'app:setLastSession': { args: [sessionPath: string | undefined]; result: void }
  /**
   * Where to land on launch, with existence already validated in main so the
   * renderer never routes to a folder or session file that has been deleted.
   */
  'app:resumeTarget': {
    args: []
    result:
      | { kind: 'session'; sessionPath: string; workspacePath: string }
      | { kind: 'workspace'; workspacePath: string }
      | { kind: 'none' }
  }
  'app:setFontPrefs': { args: [FontPrefs]; result: void }
  'app:setWorktreePrefs': { args: [WorktreePrefs]; result: void }
  /**
   * Layer 2 of the directive stack. `projectPath` undefined sets the global
   * default; a path sets that project's override, and `null` prefs clear it.
   */
  'app:setAgentDirectives': {
    args: [prefs: AgentDirectivePrefs | null, projectPath?: string]
    result: void
  }
  'app:setContextBudget': { args: [value: string]; result: void }
  /**
   * Include or leave out one kind of context file. Always updates the
   * preference new lanes start with; with a `sessionId`, also that running
   * lane (from its next model request). Other lanes are left alone.
   */
  'app:setContextFile': {
    args: [kind: ContextFileKind, included: boolean, sessionId?: string]
    result: void
  }
  'app:setRecentWorkspaces': { args: [WorkspaceInfo[]]; result: void }
  /** Absolute path of the main-process debug log, or null if it could not be opened. */
  'app:debugLogPath': { args: []; result: string | null }
  /** Reveal the debug log in the OS file manager. No-op when there is no log. */
  'app:revealDebugLog': { args: []; result: void }
  'app:setCollapsedWorkspaces': { args: [paths: string[]]; result: void }
  /**
   * Persist "this workspace is now the home target": bumps it in recents and
   * records it as lastWorkspacePath so the next launch lands here even if no
   * session is ever created.
   */
  'app:recordWorkspace': { args: [path: string]; result: void }
  /** Mark a session file as viewed now (unseen-pill bookkeeping). */
  'app:markSessionSeen': { args: [sessionPath: string]; result: void }

  /**
   * Unsent composer drafts.
   *
   * Metadata rides in `AppPrefs.drafts`; image BYTES go through the blob
   * channels below into `userData/drafts/`, because a pasted screenshot
   * re-serialised into config.json on every keystroke is not a preference.
   */
  'app:setDraft': { args: [draft: ComposerDraftRecord]; result: void }
  'app:clearDraft': { args: [key: string]; result: void }
  /** False when the write was refused for pushing past the total blob cap. */
  'app:writeDraftBlob': { args: [blobId: string, base64: string]; result: boolean }
  /** Null when the file is gone; the caller drops the chip. */
  'app:readDraftBlob': { args: [blobId: string]; result: string | null }
  /**
   * Launch-time GC: drop drafts whose workspace is gone, then unlink every
   * blob no surviving draft refers to. Returns the surviving drafts.
   */
  'app:sweepDrafts': { args: []; result: Record<string, ComposerDraftRecord> }
  /** `awsProfile` lets error remedies suggest the right `aws sso login`. */
  'app:userInfo': { args: []; result: { username: string; awsProfile?: string } }
  'app:about': { args: []; result: AboutInfo }
  'app:saveDialog': { args: [SaveDialogOptions]; result: string | null }
  'app:revealPath': { args: [string]; result: void }
  'app:openExternal': { args: [string]; result: void }

  /**
   * Put an image on the system clipboard (base64 payload).
   *
   * The renderer is sandboxed and cannot reach Electron's clipboard itself,
   * and the web `ClipboardItem` API accepts png/jpeg only — pi's image set
   * also carries gif/webp/bmp, so the write happens in main, where
   * `nativeImage` sniffs the buffer and accepts all five.
   */
  'clipboard:writeImage': { args: [image: { data: string; mimeType: string }]; result: void }
  /**
   * The clipboard's image as base64 PNG, or null when it holds none. For the
   * image annotator's Paste/Replace buttons: a button click has no paste
   * event, and the sandboxed renderer cannot read the clipboard itself.
   */
  'clipboard:readImage': { args: []; result: { data: string; mimeType: string } | null }
  'clipboard:writeFiles': { args: [paths: string[], cut: boolean]; result: void }
  'clipboard:readFiles': { args: []; result: { paths: string[]; cut: boolean } }

  /** Saves Settings → Writing and applies the spellchecker switch to the window. */
  'writing:setPrefs': { args: [prefs: WritingPrefs]; result: void }
  /**
   * Runs an edit command on the sender's focused field, the way the Edit menu
   * does. The text-field menu needs it for Paste: the sandboxed renderer cannot
   * read the clipboard, and this path still fires the field's paste event.
   */
  'writing:edit': { args: [command: EditCommand]; result: void }
  /** Adds a word to the spellchecker's dictionary (the OS one on macOS/Windows). */
  'writing:learnWord': { args: [word: string]; result: boolean }
  /** Prompts kept to learn from, oldest first. */
  'writing:prompts': { args: []; result: string[] }
  /** Keep one sent prompt to learn from. Main drops what `isLearnablePrompt` rejects. */
  'writing:recordPrompt': { args: [text: string]; result: void }
  /** Forget every learned prompt. */
  'writing:clearPrompts': { args: []; result: void }

  'fs:listFiles': { args: [workspacePath: string]; result: string[] }
  /** Effective settings: global merged with the workspace override (pi semantics). */
  'pi:agentSettings': { args: [workspacePath?: string]; result: Record<string, unknown> }
  /** Each scope's settings as written on disk — for editors, never merged. */
  'pi:agentSettingsScoped': {
    args: [workspacePath?: string]
    result: { global: Record<string, unknown>; project: Record<string, unknown> | null }
  }
  /**
   * The slash commands pi resolves for a folder, with no live session yet.
   *
   * A session gets its own list from `get_commands` at bootstrap; the home
   * composer has no session to ask, so it asks a throwaway pi instead
   * (`electron/pi/commands.ts`, cached a minute per folder). `error` is set,
   * with an empty list, when pi could not be asked at all — pi missing, or
   * the probe timed out — so the menu can say so instead of rendering the
   * same nothing it renders while the answer is still on its way.
   *
   * Main broadcasts `pi:commandsChanged` (see `PhosphorApi.onPiCommandsChanged`)
   * after anything that changes the answer; the renderer drops what it holds
   * and asks again on the next `/`.
   */
  'pi:commands': {
    args: [workspacePath?: string]
    result: { commands: RpcSlashCommand[]; error?: string }
  }
  /**
   * pi's model catalogue, for pickers with no live session yet.
   *
   * `source` is part of the answer, not a detail: when pi cannot be asked, the
   * fallback is whatever the user declared in models.json, which is a handful
   * of models rather than pi's full list. Returning that as if it were the
   * catalogue is how a configured default came to render as "unavailable" with
   * nothing anywhere saying pi had not been reached.
   */
  'pi:catalogueModels': {
    args: []
    result: {
      models: {
        id: string
        name: string
        provider: string
        reasoning: boolean
        thinkingLevelMap?: ThinkingLevelMap | null
        /** Absent when the models.json fallback answered — never guessed at. */
        contextWindow?: number
        maxTokens?: number
        cost?: ModelCost
        input?: string[]
      }[]
      source: 'pi' | 'config'
    }
  }
  'pi:readConfigFile': {
    args: [name: 'settings' | 'models' | 'web-search']
    result: { path: string; content: string }
  }
  'pi:writeConfigFile': {
    args: [name: 'settings' | 'models' | 'web-search', content: string]
    result: void
  }
  /** pi-web-access config (web-search.json), with file health for the tab. */
  'pi:webSearchConfig': {
    args: []
    result: {
      path: string
      exists: boolean
      malformed: boolean
      error?: string
      config: Record<string, unknown>
    }
  }
  'pi:patchWebSearchConfig': { args: [patch: Record<string, unknown>]; result: void }
  'pi:patchAgentSettings': {
    args: [
      scope: 'global' | 'project',
      workspacePath: string | undefined,
      patch: Record<string, unknown>,
    ]
    result: void
  }
  'pi:checkAgentSettings': { args: [workspacePath?: string]; result: AgentSettingsHealth }
  'pi:listResources': { args: []; result: PiResources }

  /** Which subscription providers pi is signed into, via `pi auth check --json`. */
  'pi:subscriptionAuth': { args: []; result: SubscriptionProviderStatus[] }
  'pi:codexUsage': { args: [force?: boolean]; result: CodexUsageResult }
  /**
   * A PTY running pi interactively so the user can complete `/login`.
   *
   * This exists because pi exposes sign-in nowhere else: no RPC command, no
   * `pi login` subcommand, and pi-ai no longer exports its OAuth runtime.
   * Hosting pi's own TUI is the only path that does not couple Phosphor to pi
   * internals. Drive it with the ordinary `pty:*` channels once created.
   */
  'pi:loginTerminal': { args: [cols: number, rows: number]; result: { ptyId: string } }

  /**
   * Sign into one provider without showing a terminal at all.
   *
   * Same TUI underneath as `pi:loginTerminal`, driven off-screen by
   * `electron/pi/login-flow.ts`: progress arrives on the `pi:loginState`
   * event, and main opens the browser itself once pi produces a URL. Resolves
   * as soon as the flow has *started*; the outcome is an event, because the
   * middle of it is a human in a browser.
   *
   * `pi:loginTerminal` stays for the escape hatch — a provider that asks
   * something this driver does not know how to answer.
   */
  'pi:startLogin': { args: [providerId: LoginProviderId]; result: void }
  /** Abort a `pi:startLogin` in progress. No-op if nothing is running. */
  'pi:cancelLogin': { args: [providerId: LoginProviderId]; result: void }

  /**
   * pi packages (settings.json `packages` arrays + install dirs). Mutations
   * shell out to pi's own package-manager CLI; output streams on
   * `packages:output:<jobId>` with the exit code on `packages:exit:<jobId>`.
   */
  /**
   * Skills page (sidebar → Skills). Resolution asks pi itself
   * (`get_commands` over a throwaway RPC process, no tokens) with a
   * filesystem scan fallback; mutations touch only the phosphor-writable roots.
   * All paths cross this boundary only after `skills:list` reported them.
   */
  'skills:list': { args: [workspacePath?: string]; result: SkillsListResult }
  /** Restore the shipped artifact skill only if its user-owned folder is absent. */
  'skills:restoreBundled': { args: []; result: void }
  'skills:readFile': {
    args: [dir: string, relPath: string]
    result: { content: string | null; binary: boolean; size: number }
  }
  'skills:create': {
    args: [
      options: {
        scope: SkillScope
        workspacePath?: string
        name: string
        description: string
        content: string
        draft: boolean
      },
    ]
    result: { dir: string }
  }
  'skills:writeFile': {
    args: [dir: string, relPath: string, content: string, workspacePath?: string]
    result: void
  }
  'skills:delete': { args: [dir: string, workspacePath?: string]; result: void }
  /** Zip the bundle and offer a save dialog. Null when the user cancelled. */
  'skills:export': { args: [dir: string]; result: { savedTo: string } | null }
  /** Install one skill from the pinned catalog into the user root. */
  'skills:install': {
    args: [
      libraryId: string,
      skillName: string,
      options?: { targetName?: string; overwrite?: boolean },
    ]
    result: { dir: string; fileCount: number }
  }
  /** Open-dialog for a .md/.zip/.skill and preview it. Null when cancelled. */
  'skills:importPick': { args: []; result: SkillImportPreview | null }
  'skills:importConfirm': {
    args: [
      options: {
        sourcePath: string
        scope: SkillScope
        workspacePath?: string
        overrideName?: string
      },
    ]
    result: { dir: string }
  }

  'packages:list': { args: [workspacePath?: string]; result: PiPackageEntry[] }
  'packages:run': {
    args: [
      action: PackageJobAction,
      spec: string | undefined,
      scope: 'global' | 'project',
      workspacePath?: string,
    ]
    result: { jobId: string }
  }
  /** One-click `npm install -g @earendil-works/pi-coding-agent` (login-shell env). */
  'packages:installPi': { args: []; result: { jobId: string } }
  /** Binary detection for catalogue recommendations (login-shell PATH). */
  'packages:detect': { args: []; result: { claude: boolean } }
  /**
   * Latest published version per npm package spec (null when unknown:
   * offline, private registry, unpublished). Best-effort, never throws.
   */
  'packages:checkUpdates': {
    args: [workspacePath?: string]
    result: Record<string, string | null>
  }
  /** Claude Code CLI health for the provider tab (binary + local auth state). */
  'packages:claudeStatus': { args: []; result: ClaudeStatus }
  /**
   * Latest published Claude Code CLI version, or null when unknown. The CLI
   * is not a pi package, so `packages:checkUpdates` never covers it.
   */
  'packages:claudeCliLatest': { args: []; result: string | null }
  /** `claude update` as a streamed job (handles native and npm installs). */
  'packages:updateClaudeCli': { args: []; result: { jobId: string } }

  /**
   * Sign the Claude Code CLI in from inside Phosphor — the account that bills a
   * Claude Pro/Max plan.
   *
   * No terminal, and no pty either: unlike pi's TUI-only `/login`,
   * `claude auth login` accepts piped stdio, so `electron/pi/claude-login.ts`
   * reads its URL off stdout and writes the pasted code back into stdin.
   * Resolves once the CLI is running; progress arrives on `claude:loginState`,
   * because the middle of it is a human in a browser. The CLI opens the browser
   * itself, so main deliberately does not.
   *
   * With no argument this adds a NEW account, in its own keychain entry. Pass
   * an existing account id to re-authenticate that one in place.
   */
  'claude:startLogin': { args: [accountId?: string]; result: void }
  /** Hand the code copied from the authorization page to the waiting CLI. */
  'claude:submitCode': { args: [code: string]; result: void }
  /** Abort a `claude:startLogin` in progress. No-op if nothing is running. */
  'claude:cancelLogin': { args: []; result: void }
  /** `claude auth logout`. Credentials are the CLI's, so this is its subcommand. */
  'claude:logout': { args: []; result: void }

  /** Main-only control traffic. Arguments and responses use the control-api parsers. */
  'control:machines': { args: []; result: ControlResult<MachinesResponse> }
  'control:lookupEnrollment': {
    args: [code: string]
    result: ControlResult<EnrollmentLookupResponse>
  }
  'control:approveEnrollment': {
    args: [code: string, label: string]
    result: ControlResult<EnrollmentApproveResponse>
  }
  'control:renameMachine': {
    args: [id: string, label: string]
    result: ControlResult<EnrollmentApproveResponse>
  }
  'control:removeMachine': { args: [id: string]; result: ControlResult<Record<never, never>> }
  /**
   * Desktop's optional Phosphor sign-in in the sidebar footer. Main owns the session; these
   * carry no token and no account id. See `electron/account/`.
   */
  'account:get': { args: []; result: AccountView }
  /** Opens the browser and resolves at once; the outcome arrives on `account:changed`. */
  'account:signIn': { args: []; result: AccountView }
  'account:cancelSignIn': { args: []; result: void }
  /** Signs out here even when Supabase cannot be told. */
  'account:signOut': { args: []; result: AccountView }

  /**
   * Every Claude login Phosphor knows about, in routing order, with each one's
   * live auth state and cached usage.
   *
   * Multiple accounts are possible because `CLAUDE_SECURESTORAGE_CONFIG_DIR`
   * moves the CLI's keychain entry without moving `~/.claude` with it. One
   * `claude auth status` per account, in parallel; usage is only ever read
   * from main's cache here, never fetched inline.
   */
  'claude:accounts': { args: []; result: ClaudeAccountsResult }
  /** Sign an account out and drop it from the list. */
  'claude:removeAccount': { args: [accountId: string]; result: void }
  /** Persist the account order — `ordered` mode walks it top to bottom. */
  'claude:reorderAccounts': { args: [ids: string[]]; result: void }
  /** Set the routing rule, and which account `specific` points at. */
  'claude:setRouting': {
    args: [mode: ClaudeRoutingMode, pinnedId?: string]
    result: void
  }
  /**
   * Re-read `/usage` for every account and recompute cooldowns.
   *
   * One zero-quota CLI run per account. The routing path never waits on this;
   * it is what the settings tab calls, and what a session start kicks off in
   * the background so the NEXT session routes on fresh numbers.
   */
  'claude:refreshAccountUsage': { args: []; result: ClaudeAccountsResult }
  /**
   * Bind a session file to the account that spawned it.
   *
   * Called by the renderer once `get_state` reveals the path — main chooses the
   * account at spawn time, but a brand-new session has no file yet. Without the
   * binding, resuming a round-robin session could land on a different plan,
   * which misses the entire prompt cache and splits the thread's cost in two.
   */
  'claude:bindSession': { args: [sessionPath: string, phosphorSessionId: string]; result: void }
  /**
   * Point a session file at an account by hand, for the next spawn.
   *
   * The lane the user is looking at cannot move: its credential is fixed by
   * the environment pi was spawned with. So "move this lane" is this call plus
   * a dispose-and-resume in the renderer, which is why main only writes the
   * binding here and never touches the subprocess.
   */
  'claude:assignSession': { args: [sessionPath: string, accountId: string]; result: void }
  /** Account id → the live Phosphor sessions spawned onto it. */
  'claude:accountSessions': { args: []; result: ClaudeAccountSessions }
  /**
   * Which account bills a session: the pick parked at spawn, else the stored
   * binding for its file. Null when no account is configured, when the session
   * is not on the Claude provider, or when neither source knows it yet.
   */
  'claude:sessionAccount': {
    args: [phosphorSessionId: string, sessionPath?: string]
    result: ClaudeSessionAccount | null
  }
  /**
   * Live subscription usage — the numbers Claude Code's own `/usage` panel
   * shows (5-hour + weekly windows, with percents), read by spawning
   * `claude -p /usage` (zero model calls, zero quota) in main and parsing
   * its rendered text. Works for every signed-in subscription account; no
   * API key, no org, no credential crosses into Phosphor. Cached ~60 s in main,
   * because the endpoint behind it rate-limits.
   *
   * `force` skips that cache for a user-initiated refresh — the only caller
   * that may, and only because someone clicked. Concurrent forces still share
   * one CLI run, so a double click cannot spawn two.
   */
  'claude:usageSnapshot': {
    args: [accountId?: string, force?: boolean]
    result: ClaudeUsageSnapshotResult
  }
  /** One print-mode turn through the pi-claude-cli provider, as a streamed job. */
  'packages:testClaudeProvider': { args: []; result: { jobId: string } }

  /**
   * pi's built-in MCP: its global and project mcp.json. The renderer names
   * scopes; paths are resolved in main only.
   */
  'mcp:readConfigs': { args: [workspacePath?: string]; result: McpConfigsResult }
  'mcp:upsertServer': {
    args: [
      scope: McpScope,
      workspacePath: string | undefined,
      name: string,
      config: McpServerConfig,
    ]
    result: void
  }
  'mcp:removeServer': {
    args: [scope: McpScope, workspacePath: string | undefined, name: string]
    result: void
  }
  'mcp:setEnabled': {
    args: [scope: McpScope, workspacePath: string | undefined, name: string, enabled: boolean]
    result: void
  }
  /**
   * `pi mcp list --json`: connect every enabled server once and report its
   * state and tools. No session needed, no tokens spent.
   */
  'mcp:list': { args: [workspacePath?: string]; result: McpListResult }
  /**
   * Sign a connector in with no session open: main runs `pi mcp login`, which
   * opens the browser itself and waits for the callback. Progress arrives on
   * `mcp:authState`; this resolves once the flow has *started*, because the
   * middle of it is a human in a browser.
   */
  'mcp:authorize': { args: [serverName: string, workspacePath?: string]; result: void }
  /** Abandon a sign-in in progress. No-op if nothing is running. */
  'mcp:cancelAuth': { args: [serverName: string]; result: void }
  /** `pi mcp logout`: delete the server's stored OAuth credentials. */
  'mcp:logout': {
    args: [serverName: string, workspacePath?: string]
    result: { ok: boolean; message: string }
  }
  /** What moving pi-mcp-adapter's config to pi's built-in MCP would do. Reads only. */
  'mcp:migrationPlan': { args: [workspacePath?: string]; result: McpMigrationPlan }
  /** Do it: write pi's mcp.json, rename the adapter's files, turn pi's MCP back on. */
  'mcp:migrate': { args: [workspacePath?: string]; result: McpMigrationResult }
  'mcp:readFile': {
    args: [scope: McpScope, workspacePath: string | undefined]
    result: { path: string; content: string }
  }
  'mcp:writeFile': {
    args: [scope: McpScope, workspacePath: string | undefined, content: string]
    result: void
  }

  'sessions:list': { args: [workspacePath: string]; result: SessionMeta[] }
  'sessions:stats': { args: [workspacePath: string]; result: WorkspaceSessionStats }
  'sessions:watch': { args: [workspacePath: string]; result: void }
  'sessions:unwatch': { args: [workspacePath: string]; result: void }
  /** Stops all matching writers, then trashes any transcript. Returns disposed handles. */
  'sessions:delete': {
    args: [sessionFilePath: string | undefined, sessionId?: string]
    result: string[]
  }
  'sessions:readTree': { args: [sessionFilePath: string]; result: SessionTree }
  'sessions:appendLabel': {
    args: [sessionFilePath: string, targetId: string, label: string | undefined]
    result: void
  }
  'sessions:jump': { args: [sessionFilePath: string, targetId: string]; result: void }
  'sessions:forkAt': { args: [sessionFilePath: string, targetId: string]; result: string }
  /**
   * The Claude Code CLI session paired with a pi session, from the provider's
   * own sidecar map. Null when there is none — the two ids are NOT the same
   * under observer mode, which is why this cannot be derived in the renderer.
   */
  'sessions:claudeSessionId': { args: [piSessionId: string]; result: string | null }
  /**
   * After pi's `clone` RPC: fork the Claude CLI ledger so the clone gets its
   * own CLI session instead of reimporting the whole conversation on its
   * first turn. Takes the CLONE's session file; true when a fork was
   * recorded, false when there was nothing to do (which is normal).
   */
  'sessions:forkClaudeLedger': { args: [cloneSessionFile: string]; result: boolean }

  /** PR for a branch via the `gh` CLI; null when gh/auth/remote is absent. */
  'gh:prForBranch': {
    args: [repoPath: string, branch: string]
    result: GhPullRequest | null
  }
  /**
   * Bounded PR listing for a whole sidebar group, with a lighter fallback
   * when check details fail. null means unavailable, not an empty repository.
   * `gh:prForBranch` stays for the single-branch popup, never per-lane fanout.
   */
  'gh:prsForRepo': {
    args: [repoPath: string]
    result: GhRepoPullRequests | null
  }
  'gh:available': { args: []; result: boolean }

  'git:info': { args: [workspacePath: string, options?: { force?: boolean }]; result: GitInfo }
  /** Cheap cached summaries (branch/worktree/dirty) for many cwds at once. */
  'git:infoBatch': { args: [cwds: string[]]; result: Record<string, GitInfo> }
  'git:statusMap': { args: [workspacePath: string]; result: Record<string, string> }
  'git:sessionBaseline': { args: [workspacePath: string]; result: string | null }
  'git:showFileAt': {
    args: [workspacePath: string, ref: string, relativePath: string]
    result: string | null
  }
  'git:restoreFileTo': {
    args: [workspacePath: string, ref: string, relativePath: string]
    result: { restored: boolean; deleted: boolean }
  }
  'git:listWorktrees': { args: [repoPath: string]; result: WorktreeInfo[] }
  'git:listBranches': {
    args: [repoPath: string]
    result: { branches: BranchInfo[]; defaultBranch: string }
  }
  /**
   * Freshest trunk ref to branch a new session from — `origin/main` when the
   * remote-tracking ref exists, else local `main`. Read-only: it never pulls,
   * so a dirty main tree is irrelevant to starting a chat.
   */
  'git:startPoint': { args: [repoPath: string]; result: StartPoint }
  /** Create `<repo>/.phosphor/worktrees/<name>` on a new or existing branch. */
  'git:addWorktree': {
    args: [repoPath: string, name: string, branch: AddWorktreeBranch]
    result: WorktreeInfo
  }
  /** Dirty worktrees are refused unless forced; branch delete is `-d` only. */
  'git:removeWorktree': {
    args: [
      repoPath: string,
      worktreePath: string,
      options: { force?: boolean; deleteBranch?: boolean },
    ]
    result:
      | { removed: true; branchDeleted: boolean; branchError?: string }
      | { removed: false; dirtyCount: number }
  }
  /**
   * Retitle a branch after the fact, safe on one a worktree has checked out.
   * A chat's branch is cut before the naming model answers, so this is how the
   * branch and the session title end up agreeing. Never throws: reports
   * `renamed: false` and the unchanged name when git refuses.
   */
  'git:renameBranch': {
    args: [repoPath: string, from: string, to: string]
    result: { renamed: boolean; branch: string }
  }
  'git:pruneWorktrees': { args: [repoPath: string]; result: { pruned: string[] } }

  /**
   * Measure what the janitor could reclaim, one report per workspace the
   * scheduled sweep covers (the recent-workspace list). Never deletes.
   * `maintenance:run` is what deletes, and it still obeys the same policy —
   * the button cannot reclaim anything a sweep would have held.
   */
  'maintenance:scan': { args: []; result: MaintenanceReport[] }
  'maintenance:run': { args: []; result: MaintenanceReport[] }
  'maintenance:setPrefs': { args: [MaintenancePrefs]; result: void }

  // ---- Optimization (Settings → Optimization) ----
  /** Headroom install/proxy state. Read-only; probes /health, spawns nothing. */
  'headroom:status': { args: []; result: HeadroomStatus }
  /** Persist the flag; on enable, bring the proxy up (adopt or spawn). */
  'headroom:setEnabled': { args: [enabled: boolean]; result: HeadroomStatus }
  'headroom:start': { args: []; result: HeadroomStatus }
  /** Stops only a proxy Phosphor spawned; an adopted proxy is left alone. */
  'headroom:stop': { args: []; result: HeadroomStatus }
  /** Guided install as a streamed job on the `packages:output/exit` channels. */
  'headroom:install': { args: []; result: { jobId: string } }
  /** Folded savings + Advisor findings for one workspace. Read-only. */
  'optimization:stats': { args: [workspacePath: string]; result: OptimizationStats }

  // ---- Voice input (Settings → Voice, docs/voice.md) ----
  'voice:status': { args: []; result: VoiceStatus }
  /**
   * Persist the prefs. Enabled downloads the selected model when it is not on
   * disk yet (progress on `voice:statusChanged`); disabled deletes every
   * model file.
   */
  'voice:setPrefs': { args: [prefs: VoicePrefs]; result: VoiceStatus }
  /**
   * Begin a dictation for this window, loading the model if it is not
   * resident. Rejects when voice is not ready or the microphone is refused.
   * One dictation at a time: a new one cancels the last.
   */
  'voice:start': { args: []; result: void }
  /** 16 kHz mono samples for the running dictation; ignored from any other window. */
  'voice:audio': { args: [samples: Float32Array]; result: void }
  /** End the dictation and return everything it heard. */
  'voice:stop': { args: []; result: { text: string } }
  'voice:cancel': { args: []; result: void }
  'git:commitAll': { args: [worktreePath: string, message: string]; result: { sha: string } }
  /** Merge into the main tree's current branch; aborts cleanly on conflict. */
  'git:mergeBranch': {
    args: [repoPath: string, branch: string]
    result:
      | { merged: true; sha: string }
      | { merged: false; reason: 'dirty'; dirtyCount: number }
      | { merged: false; reason: 'conflict'; conflicts: string[] }
  }
  /** `git fetch --prune`, throttled per repo. Never rejects — see FetchResult. */
  'git:fetch': { args: [repoPath: string, options: { force?: boolean }]; result: FetchResult }
  /** Fast-forward-only pull for the checkout at `cwd`. */
  'git:pull': { args: [cwd: string]; result: PullResult }
  /** Merge the default branch into a worktree that has fallen behind. */
  'git:updateFromMain': {
    args: [worktreePath: string, mainBranch: string]
    result: UpdateFromMainResult
  }
  /** Check a branch out in place. Refused on a dirty tree or a held branch. */
  'git:checkoutBranch': { args: [repoPath: string, branch: string]; result: CheckoutResult }

  'fs:readDir': {
    args: [
      workspacePath: string,
      dirPath: string,
      options: { showHidden?: boolean; respectGitignore?: boolean },
    ]
    result: DirEntry[]
  }
  /**
   * Images, video, audio and PDFs come back `binary` WITHOUT being read: the
   * viewer streams them over `fs:previewUrl` instead.
   */
  'fs:readFile': { args: [path: string]; result: FileContent }
  /**
   * A `phosphor-file://` URL for the Files pane's viewer of `path` — a
   * single-file grant for media/PDF, a workspace-scoped sandboxed document
   * grant for HTML. Rejects for a type with no viewer.
   * See electron/fs/file-protocol.ts.
   */
  'fs:previewUrl': { args: [workspacePath: string, path: string]; result: string }
  /** Hand a file the pane cannot render to the OS. Refuses anything it would RUN. */
  'fs:openInDefaultApp': { args: [path: string]; result: OpenInDefaultAppResult }
  /** macOS Quick Look panel; a no-op elsewhere. Never executes the file. */
  'fs:quickLook': { args: [path: string]; result: void }
  'fs:writeFile': {
    args: [path: string, content: string, expected?: string | null]
    result: { mtimeMs: number; revision?: string }
  }
  'fs:createFile': { args: [path: string]; result: void }
  'fs:createDir': { args: [path: string]; result: void }
  'fs:rename': { args: [from: string, to: string]; result: void }
  'fs:trash': { args: [path: string]; result: void }
  /** Import/copy or move one entry. Returns its destination; refuses replacement. */
  'fs:transfer': {
    args: [workspace: string, source: string, directory: string, mode: 'copy' | 'move']
    result: string
  }
  'fs:pickEntries': { args: [kind: 'file' | 'folder']; result: string[] }
  'fs:watchWorkspace': { args: [workspacePath: string]; result: void }
  /**
   * Lightweight fallback for workspace-watch failures. Only directory metadata
   * is read; file contents (including large binaries) are never opened.
   */
  'fs:statDirs': {
    args: [paths: string[]]
    result: Array<{ path: string; mtimeMs: number | null }>
  }
  /**
   * Full-text search over the workspace's files, in a worker thread that main
   * can stop mid-regex. A newer search from the same window replaces the one
   * running. See electron/fs/workspace-search-service.ts.
   */
  'fs:searchWorkspace': { args: [request: WorkspaceSearchRequest]; result: WorkspaceSearchResult }
  /**
   * Stop this window's running search, if it is `searchId`; it resolves with
   * what it found, `stopped: 'cancelled'`.
   */
  'fs:cancelWorkspaceSearch': { args: [searchId: string]; result: void }

  'pty:create': {
    /**
     * `sessionId` is the OWNING chat session. Main needs it to attribute a
     * terminal's process tree (a build, a test run, a dev server) to that
     * session in the resource monitor; without it that mapping lives only in
     * the renderer's terminal store and main cannot see it.
     */
    args: [workspacePath: string, cols: number, rows: number, sessionId?: string]
    result: { ptyId: string }
  }
  /**
   * Recent output for a view that is (re)binding to an already-live PTY —
   * closing the terminal pane disposes the xterm but keeps the shell, so
   * without a replay reopening shows a blank pane in front of a running
   * shell. See `PtyManager.attach` for why this needs no de-duplication.
   */
  'pty:attach': { args: [ptyId: string]; result: { scrollback: string } }
  'pty:write': { args: [ptyId: string, data: string]; result: void }
  'pty:resize': { args: [ptyId: string, cols: number, rows: number]; result: void }
  'pty:kill': { args: [ptyId: string]; result: void }

  /**
   * Auto-update. Checks are driven by main on a timer; the renderer only reads
   * state and asks for the install. Installing is ALWAYS user-initiated.
   */
  'updates:state': { args: []; result: UpdateState }
  'updates:check': { args: []; result: void }
  'updates:restartAndInstall': { args: []; result: void }

  /**
   * App rating and feedback, filed as a GitHub issue. Main owns the network
   * leg because the relay path is a request and the browser path is
   * `shell.openExternal` — neither belongs in a sandboxed renderer.
   */
  'feedback:state': { args: []; result: FeedbackState }
  'feedback:submit': { args: [draft: FeedbackDraft]; result: FeedbackSubmitResult }
  /** Records the one-time "not now"; the nudge never returns after it. */
  'feedback:dismiss': { args: []; result: void }
}

export type IpcInvokeChannel = keyof IpcInvokeMap

export const sessionEventChannel = (sessionId: string): string => `pi:event:${sessionId}`

/** The API surface exposed on window.phosphor by the preload script. */
/** Host platform, normalized. Anything exotic (bsd, sunos) reads as 'linux'. */
export type PhosphorPlatform = 'darwin' | 'win32' | 'linux'

export interface PhosphorApi {
  /**
   * The host platform, synchronously. Key-hint labels are rendered during the
   * first paint, so this cannot be an async `invoke` without every shortcut
   * flashing the wrong modifier first.
   */
  platform: PhosphorPlatform

  invoke<C extends IpcInvokeChannel>(
    channel: C,
    ...args: IpcInvokeMap[C]['args']
  ): Promise<IpcInvokeMap[C]['result']>

  /**
   * Subscribe to a live session's pushed events.
   * Returns an unsubscribe function.
   */
  onSessionPush(sessionId: string, listener: (push: SessionPush) => void): () => void

  /** Session-dir change notifications (chokidar); returns unsubscribe. */
  onSessionsChanged(listener: (payload: { workspacePath: string }) => void): () => void
  /** Invalidation only; reconnecting windows read an authoritative snapshot. */
  onRoutinesChanged(listener: (event?: { machine?: string }) => void): () => void

  /**
   * The set of slash commands pi would resolve has changed — a package was
   * installed or removed, an MCP server added or reconnected, a skill written. Fired from
   * main after the mutation, for every window. Listeners drop their cached
   * `pi:commands` answers and re-ask live sessions for `get_commands`.
   */
  onPiCommandsChanged(listener: () => void): () => void

  /** Workspace file-change notifications; returns unsubscribe. */
  onFsChanged(listener: (payload: { workspacePath: string; paths: string[] }) => void): () => void

  /** Package job output stream (pi install/remove/update, pi self-install). */
  onPackagesJobOutput(jobId: string, listener: (data: string) => void): () => void
  /** Package job completion; exit code 0 means success. */
  onPackagesJobExit(jobId: string, listener: (exitCode: number) => void): () => void

  /** PTY output stream; returns unsubscribe. */
  onPtyData(ptyId: string, listener: (data: string) => void): () => void
  /** PTY exit notification; returns unsubscribe. */
  onPtyExit(ptyId: string, listener: (exitCode: number) => void): () => void
  /** Busy map broadcast (ptyId → foreground process running); unsubscribe. */
  onPtyStatus(listener: (statuses: Record<string, boolean>) => void): () => void
  /** Update lifecycle changes (checking / downloading / ready to install). */
  onUpdateEvent(listener: (state: UpdateState) => void): () => void
  /** Progress of a background `mcp:authorize`; returns unsubscribe. */
  onMcpAuthState(listener: (push: ConnectorAuthPush) => void): () => void
  onPiLoginState(listener: (state: LoginFlowState) => void): () => void
  /** Progress of a background `claude:startLogin`; returns unsubscribe. */
  onClaudeLoginState(listener: (state: ClaudeLoginState) => void): () => void
  /** The Phosphor account changed: signing in, signed in or out, preview toggled. */
  onAccountChanged(listener: (view: AccountView) => void): () => void
  /** A change signal only. Refetch the enrolled machines through control:machines. */
  onMachinesChanged(listener: () => void): () => void
  onSshInstall(jobId: string, listener: (event: SshInstallEvent) => void): () => void
  onHostsChanged(listener: () => void): () => void
  /** Attention from any Host (49). */
  onHostAttention(listener: (event: HostAttention) => void): () => void
  /** A notification was clicked: open this remote lane. */
  onHostOpenLane(listener: (target: { hostId: string; laneId: string }) => void): () => void
  /** Voice prefs, download progress and readiness; returns unsubscribe. */
  onVoiceStatus(listener: (status: VoiceStatus) => void): () => void

  /**
   * Absolute path for a dropped File (Electron `webUtils`). Non-image
   * attachments are handed to pi as paths, so it needs the real location.
   */
  pathForFile(file: File): string

  /**
   * Spelling suggestions for one word, from Chromium's spellchecker through
   * `webFrame`: null when the word is spelled correctly (or no dictionary is
   * loaded), otherwise the suggestions, possibly none. Synchronous so the
   * right-click menu can open at once. Not the `context-menu` event's
   * `dictionarySuggestions`, which came back empty on macOS with the spelling
   * language set to Automatic (electron#24455) while this answered.
   */
  spellingSuggestions(word: string): string[] | null

  /** Convenience wrapper: send an RPC command and get the typed response data. */
  piCommand<T extends RpcCommand['type']>(
    sessionId: string,
    command: Extract<RpcCommand, { type: T }>,
  ): Promise<RpcResponse<RpcResponseDataMap[T]>>
}

declare global {
  interface Window {
    phosphor: PhosphorApi
  }
}
