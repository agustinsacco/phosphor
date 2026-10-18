import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap, SessionTree } from '../ipc'
import type { WorkspaceSearchRequest, WorkspaceSearchResult } from '../workspace-search'
import type {
  AddWorktreeBranch,
  BranchInfo,
  CheckoutResult,
  DirEntry,
  FetchResult,
  FileContent,
  OpenInDefaultAppResult,
  GhPullRequest,
  GhRepoPullRequests,
  GitInfo,
  PullResult,
  SessionMeta,
  StartPoint,
  UpdateFromMainResult,
  WorkspaceSessionStats,
  WorktreeInfo,
} from '../models'
export interface BaselineSessionsInvokeMap {
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
}
export interface BaselineGitInvokeMap {
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
}
export interface BaselineGhInvokeMap {
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
}
export interface BaselineFsInvokeMap {
  'fs:listFiles': { args: [workspacePath: string]; result: string[] }

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
}
it('freezes sessions, git, gh, fs channel tuples and results through ipc.ts', () => {
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineSessionsInvokeMap>
  >().toEqualTypeOf<BaselineSessionsInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineGitInvokeMap>
  >().toEqualTypeOf<BaselineGitInvokeMap>()
  expectTypeOf<Pick<IpcInvokeMap, keyof BaselineGhInvokeMap>>().toEqualTypeOf<BaselineGhInvokeMap>()
  expectTypeOf<Pick<IpcInvokeMap, keyof BaselineFsInvokeMap>>().toEqualTypeOf<BaselineFsInvokeMap>()
})
