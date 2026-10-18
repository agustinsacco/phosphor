import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap } from '../ipc'
import type { ContextFileKind } from '../context-files'
import type {
  AppPrefs,
  AboutInfo,
  AgentDirectivePrefs,
  FontPrefs,
  ModelPicks,
  SandboxInfo,
  SaveDialogOptions,
  ThemePreference,
  WorkspaceInfo,
  WorktreePrefs,
  ComposerDraftRecord,
  LanePrefs,
} from '../models'
export interface BaselineAppInvokeMap {
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
}
it('freezes app channel tuples and results through ipc.ts', () => {
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineAppInvokeMap>
  >().toEqualTypeOf<BaselineAppInvokeMap>()
})

import type { AppInvokeMap } from './app'

it('keeps app leaf exact and confined to its prefix', () => {
  expectTypeOf<AppInvokeMap>().toEqualTypeOf<BaselineAppInvokeMap>()
  expectTypeOf<keyof AppInvokeMap>().toEqualTypeOf<Extract<keyof IpcInvokeMap, `app:${string}`>>()
})
