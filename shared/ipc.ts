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
  ThinkingLevelMap,
  ModelCost,
} from './rpc'
import type { ConnectorCheckResult } from './connectors'
import type {
  McpCacheEntry,
  McpConfigsResult,
  McpScope,
  McpServerConfig,
  McpWriteScope,
} from './mcp'
import type { SkillImportPreview, SkillScope, SkillsListResult } from './skills'
import type {
  AddWorktreeBranch,
  AppPrefs,
  AboutInfo,
  AgentSettingsHealth,
  BranchInfo,
  CheckoutResult,
  ClaudeAccountsResult,
  ClaudeRoutingMode,
  ClaudeStatus,
  ClaudeUsageSnapshotResult,
  ConnectorAuthPush,
  ClaudeLoginState,
  AgentDirectivePrefs,
  CreateSessionOptions,
  DirEntry,
  FetchResult,
  FileContent,
  FontPrefs,
  PackageJobAction,
  PiPackageEntry,
  GhPullRequest,
  GitInfo,
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

export interface IpcInvokeMap {
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
   * The "No folder" option: the `<userData>/sandboxes/sandbox-N` folder a
   * project-less session should run in. An empty sandbox is reused; a fresh
   * one is minted only when every existing sandbox holds something. From then
   * on it is an ordinary workspace (recents, sessions, removal).
   */
  'app:createSandbox': { args: []; result: string }
  /** Every sandbox on disk, most recently touched first (Settings lists it). */
  'app:listSandboxes': { args: []; result: SandboxInfo[] }
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
   * `pidex-artifact://` URL for it. The document is served on its own opaque
   * origin with `default-src 'none'`, which is what lets it run scripts
   * without the app's CSP — see electron/artifacts/artifact-protocol.ts.
   */
  'artifacts:stageHtml': { args: [html: string]; result: string }
  'app:setPinnedSessions': { args: [string[]]; result: void }
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
  'app:setClaudeAutocompact': { args: [value: string]; result: void }
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
  'clipboard:writeFiles': { args: [paths: string[], cut: boolean]; result: void }
  'clipboard:readFiles': { args: []; result: { paths: string[]; cut: boolean } }

  'fs:listFiles': { args: [workspacePath: string]; result: string[] }
  /** Effective settings: global merged with the workspace override (pi semantics). */
  'pi:agentSettings': { args: [workspacePath?: string]; result: Record<string, unknown> }
  /** Each scope's settings as written on disk — for editors, never merged. */
  'pi:agentSettingsScoped': {
    args: [workspacePath?: string]
    result: { global: Record<string, unknown>; project: Record<string, unknown> | null }
  }
  /** Models from pi's models.json, for pickers with no live session yet. */
  'pi:catalogueModels': {
    args: []
    result: {
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
  /**
   * A PTY running pi interactively so the user can complete `/login`.
   *
   * This exists because pi exposes sign-in nowhere else: no RPC command, no
   * `pi login` subcommand, and pi-ai no longer exports its OAuth runtime.
   * Hosting pi's own TUI is the only path that does not couple pidex to pi
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
   * filesystem scan fallback; mutations touch only the pidex-writable roots.
   * All paths cross this boundary only after `skills:list` reported them.
   */
  'skills:list': { args: [workspacePath?: string]; result: SkillsListResult }
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
   * Sign the Claude Code CLI in from inside pidex — the account that bills a
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

  /**
   * Every Claude login pidex knows about, in routing order, with each one's
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
  'claude:bindSession': { args: [sessionPath: string, pidexSessionId: string]; result: void }
  /**
   * Live subscription usage — the numbers Claude Code's own `/usage` panel
   * shows (5-hour + weekly windows, with percents), read by spawning
   * `claude -p /usage` (zero model calls, zero quota) in main and parsing
   * its rendered text. Works for every signed-in subscription account; no
   * API key, no org, no credential crosses into pidex. Cached ~60 s in main,
   * because the endpoint behind it rate-limits.
   */
  'claude:usageSnapshot': { args: [accountId?: string]; result: ClaudeUsageSnapshotResult }
  /** One print-mode turn through the pi-claude-cli provider, as a streamed job. */
  'packages:testClaudeProvider': { args: []; result: { jobId: string } }

  /**
   * MCP config chain (pi-mcp-adapter). The renderer names scopes; paths are
   * resolved in main only.
   */
  'mcp:readConfigs': { args: [workspacePath?: string]; result: McpConfigsResult }
  'mcp:upsertServer': {
    args: [
      scope: McpWriteScope,
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
  'mcp:setDisabled': {
    args: [scope: McpScope, workspacePath: string | undefined, name: string, disabled: boolean]
    result: void
  }
  'mcp:readCache': { args: []; result: McpCacheEntry[] }

  /**
   * Authorize a connector with no session open.
   *
   * OAuth belongs to the MCP adapter and only runs inside pi, so main spawns a
   * throwaway `pi --mode rpc --no-session`, sends the adapter's own
   * `/mcp-auth <server>` (an extension command — no model call, no tokens),
   * opens the browser, and kills the process when the flow settles. Progress
   * arrives on `mcp:authState`; this resolves once the flow has *started*,
   * because the middle of it is a human in a browser.
   */
  'mcp:authorize': { args: [serverName: string, workspacePath?: string]; result: void }
  /**
   * Answer the adapter's prompt with a pasted callback URL, for a loopback
   * callback that never arrived. False when nothing is waiting for one.
   */
  'mcp:submitAuthCallback': { args: [serverName: string, url: string]; result: boolean }
  /** Abandon an authorization in progress. No-op if nothing is running. */
  'mcp:cancelAuth': { args: [serverName: string]; result: void }
  /**
   * Test one connector, with or without a session open.
   *
   * Main spawns a throwaway `pi --mode rpc --no-session` and sends the
   * adapter's `/mcp reconnect <server>` (an extension command — no model
   * call, no tokens), which closes and re-opens the connection and reports
   * the outcome. Always resolves: an unrecognised answer is `unknown`, never
   * a wrong verdict.
   */
  'mcp:checkServer': {
    args: [serverName: string, workspacePath?: string]
    result: ConnectorCheckResult
  }
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
  'sessions:delete': { args: [sessionFilePath: string]; result: void }
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

  /** PR for a branch via the `gh` CLI; null when gh/auth/remote is absent. */
  'gh:prForBranch': {
    args: [repoPath: string, branch: string]
    result: GhPullRequest | null
  }
  /**
   * Every recent PR in a repo, keyed by head branch — one `gh` subprocess for
   * a whole sidebar group. `gh:prForBranch` stays for the single-branch popup;
   * fanning it out across N lanes is N subprocesses per refresh.
   */
  'gh:prsForRepo': {
    args: [repoPath: string]
    result: Record<string, GhPullRequest>
  }
  'gh:available': { args: []; result: boolean }

  'git:info': { args: [workspacePath: string]; result: GitInfo }
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
  /** Create `<repo>/.pidex/worktrees/<name>` on a new or existing branch. */
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
  'fs:readFile': { args: [path: string]; result: FileContent }
  'fs:writeFile': { args: [path: string, content: string]; result: { mtimeMs: number } }
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
}

export type IpcInvokeChannel = keyof IpcInvokeMap

export const sessionEventChannel = (sessionId: string): string => `pi:event:${sessionId}`

/** The API surface exposed on window.pidex by the preload script. */
/** Host platform, normalized. Anything exotic (bsd, sunos) reads as 'linux'. */
export type PidexPlatform = 'darwin' | 'win32' | 'linux'

export interface PidexApi {
  /**
   * The host platform, synchronously. Key-hint labels are rendered during the
   * first paint, so this cannot be an async `invoke` without every shortcut
   * flashing the wrong modifier first.
   */
  platform: PidexPlatform

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
  /** Progress of a background `pi:startLogin`; returns unsubscribe. */
  onMcpAuthState(listener: (push: ConnectorAuthPush) => void): () => void
  onPiLoginState(listener: (state: LoginFlowState) => void): () => void
  /** Progress of a background `claude:startLogin`; returns unsubscribe. */
  onClaudeLoginState(listener: (state: ClaudeLoginState) => void): () => void

  /**
   * Absolute path for a dropped File (Electron `webUtils`). Non-image
   * attachments are handed to pi as paths, so it needs the real location.
   */
  pathForFile(file: File): string

  /** Convenience wrapper: send an RPC command and get the typed response data. */
  piCommand<T extends RpcCommand['type']>(
    sessionId: string,
    command: Extract<RpcCommand, { type: T }>,
  ): Promise<RpcResponse<RpcResponseDataMap[T]>>
}

declare global {
  interface Window {
    pidex: PidexApi
  }
}
