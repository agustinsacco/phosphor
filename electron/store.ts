import { existsSync } from 'node:fs'
import Store from 'electron-store'
import {
  blobIdsOf,
  pruneDrafts,
  pruneLaneMarkers,
  pruneSeenSessions,
  visibleWorkspaces,
} from './prefs-utils'
import {
  DEFAULT_APP_PREFS,
  DEFAULT_CLAUDE_ACCOUNT_PREFS,
  DEFAULT_MAINTENANCE_PREFS,
  DEFAULT_MODEL_PICKS,
  type MaintenancePrefs,
  normalizeLanePrefs,
  type LanePrefs,
  type AgentDirectivePrefs,
  type AppPrefs,
  type ClaudeAccountPrefs,
  type ComposerDraftRecord,
  type ThemePreference,
  type WorkspaceInfo,
} from '@shared/models'

/**
 * True for a path inside a repo's internal worktree folder
 * (`<repo>/.phosphor/worktrees/<name>`). A worktree is a branch of an existing
 * workspace, not a workspace itself, so it must never persist as one.
 */
// `.pidex` is the pre-rename (2026-09-08) folder; existing lanes still live there.
const WORKTREE_SEGMENT = /[/\\]\.(?:phosphor|pidex)[/\\]worktrees[/\\]/
function isWorktreeFolder(path: string): boolean {
  return WORKTREE_SEGMENT.test(path)
}

/**
 * Constructed lazily, NOT at module scope.
 *
 * electron-store resolves `userData` the moment it is instantiated, and ES
 * imports are hoisted — a module-scope `new Store()` would run while main.ts
 * is still importing, i.e. before main.ts can redirect userData for E2E runs.
 * That leaked test workspaces into the developer's real prefs. Deferring the
 * construction to first use keeps the redirect effective.
 */
let store: Store<AppPrefs> | null = null

function prefs(): Store<AppPrefs> {
  store ??= new Store<AppPrefs>({ defaults: DEFAULT_APP_PREFS })
  return store
}

/**
 * Clamp the janitor's numbers on read. Prefs are user-editable JSON, and these
 * two decide how often a timer fires and how old a directory must be before it
 * can be deleted — a zero or a negative in either is not a setting worth
 * honouring.
 */
function normalizeMaintenancePrefs(
  stored: Partial<MaintenancePrefs> | undefined,
): MaintenancePrefs {
  const merged = { ...DEFAULT_MAINTENANCE_PREFS, ...stored }
  return {
    ...merged,
    intervalMinutes: Math.max(
      15,
      Math.floor(merged.intervalMinutes) || DEFAULT_MAINTENANCE_PREFS.intervalMinutes,
    ),
    minAgeHours: Math.max(
      1,
      Math.floor(merged.minAgeHours) || DEFAULT_MAINTENANCE_PREFS.minAgeHours,
    ),
  }
}

export function getPrefs(): AppPrefs {
  const s = prefs()
  return {
    theme: s.get('theme'),
    // Read-only prune: worktree folders (never workspaces) and folders that
    // no longer exist. Deliberately not written back — see `visibleWorkspaces`.
    recentWorkspaces: visibleWorkspaces(
      s.get('recentWorkspaces') ?? [],
      isWorktreeFolder,
      existsSync,
    ),
    lastWorkspacePath: s.get('lastWorkspacePath'),
    lastSessionPath: s.get('lastSessionPath'),
    pinnedSessions: s.get('pinnedSessions') ?? [],
    modelPicks: { ...DEFAULT_MODEL_PICKS, ...s.get('modelPicks') },
    collapsedWorkspaces: s.get('collapsedWorkspaces') ?? [],
    seenSessions: s.get('seenSessions') ?? {},
    laneMarkers: s.get('laneMarkers') ?? {},
    // Normalized on read as well as write: prefs are user-editable JSON, and
    // these numbers reach a prompt, a git ref and a filesystem path.
    lanes: normalizeLanePrefs(s.get('lanes')),
    maintenance: normalizeMaintenancePrefs(s.get('maintenance')),
    fonts: { ...DEFAULT_APP_PREFS.fonts, ...s.get('fonts') },
    agentDirectives: {
      ...DEFAULT_APP_PREFS.agentDirectives,
      ...s.get('agentDirectives'),
    },
    // Merged per entry, not passed through: a stored override predates any
    // directive block added later, and an absent key must mean "take the
    // default", never "off". Only the keys the user actually set win.
    agentDirectivesByProject: Object.fromEntries(
      Object.entries(s.get('agentDirectivesByProject') ?? {}).map(([path, directives]) => [
        path,
        { ...DEFAULT_APP_PREFS.agentDirectives, ...directives },
      ]),
    ),
    worktrees: { ...DEFAULT_APP_PREFS.worktrees, ...s.get('worktrees') },
    claudeAutocompact: s.get('claudeAutocompact') ?? '',
    drafts: s.get('drafts') ?? {},
  }
}

/**
 * Store one composer draft, pruning the map back to `MAX_DRAFTS`.
 *
 * Returns the blob ids that the prune dropped, so the caller can unlink their
 * files. Without that return the images would outlive every reference to them
 * and `userData/drafts/` would only ever grow.
 */
export function setDraft(draft: ComposerDraftRecord): string[] {
  const s = prefs()
  const next = { ...(s.get('drafts') ?? {}), [draft.key]: draft }
  const { drafts, dropped } = pruneDrafts(next)
  s.set('drafts', drafts)
  return dropped
}

/** Forget one draft. Returns its blob ids so the caller can unlink them. */
export function clearDraft(key: string): string[] {
  const s = prefs()
  const drafts = { ...(s.get('drafts') ?? {}) }
  const removed = drafts[key]
  if (!removed) return []
  delete drafts[key]
  s.set('drafts', drafts)
  return blobIdsOf([removed])
}

/** Replace the whole map — used by the launch-time sweep. */
export function setDrafts(drafts: Record<string, ComposerDraftRecord>): void {
  prefs().set('drafts', drafts)
}

/**
 * Claude accounts and their routing rule.
 *
 * Read through a merge with the defaults, not returned raw: this pref is
 * user-editable JSON that decides which credential a spawn runs under, and a
 * hand-edited file missing `cooldowns` must not crash a session start.
 */
export function getClaudeAccountPrefs(): ClaudeAccountPrefs {
  return { ...DEFAULT_CLAUDE_ACCOUNT_PREFS, ...prefs().get('claudeAccounts') }
}

export function setClaudeAccountPrefs(value: ClaudeAccountPrefs): void {
  prefs().set('claudeAccounts', value)
}

/** See AppPrefs.claudeAutocompact — stored trimmed; '' means provider default. */
export function setClaudeAutocompact(value: string): void {
  prefs().set('claudeAutocompact', value.trim())
}

/** Record that the user has viewed a session's current state. */
export function markSessionSeen(sessionPath: string): void {
  const s = prefs()
  const seen = { ...(s.get('seenSessions') ?? {}), [sessionPath]: Date.now() }
  s.set('seenSessions', pruneSeenSessions(seen))
}

export function setFontPrefs(fonts: AppPrefs['fonts']): void {
  prefs().set('fonts', fonts)
}

export function setWorktreePrefs(worktrees: AppPrefs['worktrees']): void {
  prefs().set('worktrees', worktrees)
}

export function setMaintenancePrefs(maintenance: AppPrefs['maintenance']): void {
  prefs().set('maintenance', maintenance)
}

/**
 * Set the directive stack, globally or for one project.
 *
 * `null` for a project clears its override so it inherits the global default
 * again. Deleting the key rather than storing a copy keeps "inherits" and
 * "happens to match" distinguishable in the settings UI.
 */
export function setAgentDirectives(
  directives: AgentDirectivePrefs | null,
  projectPath?: string,
): void {
  if (!projectPath) {
    if (directives) prefs().set('agentDirectives', directives)
    return
  }
  const byProject = { ...(prefs().get('agentDirectivesByProject') ?? {}) }
  if (directives) {
    byProject[projectPath] = directives
  } else {
    delete byProject[projectPath]
  }
  prefs().set('agentDirectivesByProject', byProject)
}

export function setRecentWorkspaces(workspaces: AppPrefs['recentWorkspaces']): void {
  prefs().set('recentWorkspaces', workspaces)
}

export function setPinnedSessions(paths: string[]): void {
  prefs().set('pinnedSessions', paths)
}

export function setLaneMarkers(markers: Record<string, string>): void {
  prefs().set('laneMarkers', pruneLaneMarkers(markers))
}

export function setLanePrefs(lanes: LanePrefs): void {
  prefs().set('lanes', normalizeLanePrefs(lanes))
}

export function getLanePrefs(): LanePrefs {
  return normalizeLanePrefs(prefs().get('lanes'))
}

export function setModelPicks(picks: AppPrefs['modelPicks']): void {
  prefs().set('modelPicks', picks)
}

export function setCollapsedWorkspaces(paths: string[]): void {
  prefs().set('collapsedWorkspaces', paths)
}

/**
 * Remember the session to reopen on next launch. `undefined` clears it, so
 * closing a session means the app lands on that workspace's home screen
 * rather than reopening something the user deliberately left.
 */
export function setLastSession(sessionPath: string | undefined): void {
  const s = prefs()
  if (sessionPath) s.set('lastSessionPath', sessionPath)
  else s.delete('lastSessionPath')
}

export function setTheme(theme: ThemePreference): void {
  prefs().set('theme', theme)
}

export function recordWorkspace(path: string, name: string): void {
  const s = prefs()
  const now = Date.now()
  const workspaces = s.get('recentWorkspaces')
  // The last-opened workspace is always remembered (it drives launch resume),
  // but only real workspaces enter the recents list the sidebar orders by.
  if (!isWorktreeFolder(path)) {
    const entry: WorkspaceInfo = { path, name, lastOpenedAt: now }
    // Recency is metadata for launch recovery, not sidebar order. Preserve an
    // existing workspace's position; only a newly opened folder is appended.
    const index = workspaces.findIndex((workspace) => workspace.path === path)
    const next =
      index < 0
        ? [...workspaces, entry].slice(-20)
        : workspaces.map((workspace) => (workspace.path === path ? entry : workspace))
    s.set('recentWorkspaces', next)
  }
  s.set('lastWorkspacePath', path)
}
