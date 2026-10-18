import type { ArtifactListing, ArtifactSnapshot } from '../artifacts'
import type {
  McpConfigsResult,
  McpListResult,
  McpMigrationPlan,
  McpMigrationResult,
  McpScope,
  McpServerConfig,
} from '../mcp'
import type { SkillImportPreview, SkillScope, SkillsListResult } from '../skills'
import type { ClaudeStatus, PackageJobAction, PiPackageEntry } from '../models'

export interface SkillsInvokeMap {
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
}
export interface PackagesInvokeMap {
  /**
   * pi packages (settings.json `packages` arrays + install dirs). Mutations
   * shell out to pi's own package-manager CLI; output streams on
   * `packages:output:<jobId>` with the exit code on `packages:exit:<jobId>`.
   */
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
  /** One print-mode turn through the pi-claude-cli provider, as a streamed job. */
  'packages:testClaudeProvider': { args: []; result: { jobId: string } }
}
export interface McpInvokeMap {
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
}
export interface ArtifactsInvokeMap {
  /**
   * Stage model-authored HTML for the artifact iframe and return a
   * `phosphor-artifact://` URL for it. The document is served on its own opaque
   * origin with `default-src 'none'`, which is what lets it run scripts
   * without the app's CSP — see apps/desktop/electron/artifacts/artifact-protocol.ts.
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
}
