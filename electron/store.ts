import { realpathSync } from 'node:fs'
import { basename, sep } from 'node:path'
import Store from 'electron-store'
import {
  blobIdsOf,
  canonicalPaths,
  type PathMove,
  pruneDrafts,
  pruneLaneMarkers,
  pruneSeenSessions,
  repointPath,
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
import { type FeedbackPrefs, normalizeFeedbackPrefs } from '@shared/feedback'
import { migrateRenamedPrefs, type RawPrefs } from './prefs-migrations'

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
 * A folder's real path, or null when it is gone.
 *
 * `realpathSync.native` is deliberately the same rule pi uses (pi-paths.ts):
 * pi names a session directory after the RESOLVED cwd, so two spellings of one
 * folder share a transcript directory whether Phosphor notices or not. Storing
 * the resolved path is how Phosphor comes to agree — one folder, one entry, one
 * sidebar group.
 *
 * Doubles as the existence check, since resolving a path that is not there
 * throws.
 */
export function realPathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/** `realPathOrNull`, for a value that must survive the folder being gone. */
function resolvedOrSame(path: string | undefined): string | undefined {
  return path === undefined ? undefined : (realPathOrNull(path) ?? path)
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
  if (!store) {
    store = new Store<AppPrefs>({ defaults: DEFAULT_APP_PREFS })
    migrateRenamedPrefs(store as unknown as RawPrefs)
  }
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
      realPathOrNull,
      basename,
    ),
    // Resolved on read, like recents. This is what launch resume hands to
    // `openWorkspace`, which compares recents by exact string — a value stored
    // by an older build under a symlinked spelling opened a second in-memory
    // group beside the resolved one, for the whole of that launch.
    lastWorkspacePath: resolvedOrSame(s.get('lastWorkspacePath')),
    lastSessionPath: s.get('lastSessionPath'),
    pinnedSessions: s.get('pinnedSessions') ?? [],
    sessionOrder: s.get('sessionOrder') ?? [],
    modelPicks: { ...DEFAULT_MODEL_PICKS, ...s.get('modelPicks') },
    collapsedWorkspaces: canonicalPaths(s.get('collapsedWorkspaces') ?? [], realPathOrNull),
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
    headroom: { ...DEFAULT_APP_PREFS.headroom, ...s.get('headroom') },
    feedback: normalizeFeedbackPrefs(s.get('feedback')),
    contextBudget: s.get('contextBudget') ?? '',
    drafts: s.get('drafts') ?? {},
  }
}

export function setHeadroomPrefs(headroom: AppPrefs['headroom']): void {
  prefs().set('headroom', headroom)
}

export function getFeedbackPrefs(): FeedbackPrefs {
  return normalizeFeedbackPrefs(prefs().get('feedback'))
}

/** Merge a patch into the feedback prefs. Normalized on the way in and out. */
export function patchFeedbackPrefs(patch: Partial<FeedbackPrefs>): FeedbackPrefs {
  const next = normalizeFeedbackPrefs({ ...getFeedbackPrefs(), ...patch })
  prefs().set('feedback', next)
  return next
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

/** See AppPrefs.contextBudget — stored trimmed; '' means the default budget. */
export function setContextBudget(value: string): void {
  prefs().set('contextBudget', value.trim())
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

export function setSessionOrder(paths: string[]): void {
  prefs().set('sessionOrder', [...new Set(paths)])
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

/**
 * Rewrite every persisted path that sits at or under one of `moves`.
 *
 * Left alone after a sandbox rename, each of these names something that no
 * longer exists: the next launch resumes nothing, and every pin, marker and
 * unseen-badge on that sandbox's chats silently drops. The matching rule (and
 * why it is a prefix) is `repointPath`.
 */
export function repointStoredPaths(moves: readonly PathMove[]): void {
  const s = prefs()
  const remap = (path: string): string => repointPath(path, moves, sep)
  const remapKeys = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [remap(key), value]))

  s.set(
    'recentWorkspaces',
    s.get('recentWorkspaces').map((workspace) => {
      const path = remap(workspace.path)
      // The display name is the basename, so a rename has to refresh it too.
      return path === workspace.path ? workspace : { ...workspace, path, name: basename(path) }
    }),
  )

  const lastWorkspace = s.get('lastWorkspacePath')
  if (lastWorkspace) s.set('lastWorkspacePath', remap(lastWorkspace))
  const lastSession = s.get('lastSessionPath')
  if (lastSession) s.set('lastSessionPath', remap(lastSession))

  s.set('pinnedSessions', (s.get('pinnedSessions') ?? []).map(remap))
  s.set('sessionOrder', (s.get('sessionOrder') ?? []).map(remap))
  s.set('collapsedWorkspaces', (s.get('collapsedWorkspaces') ?? []).map(remap))
  s.set('seenSessions', remapKeys(s.get('seenSessions') ?? {}))
  s.set('laneMarkers', remapKeys(s.get('laneMarkers') ?? {}))
  s.set('agentDirectivesByProject', remapKeys(s.get('agentDirectivesByProject') ?? {}))

  // A draft is keyed by the surface it belongs to and separately records its
  // own workspace, so both sides need the rewrite or a sandbox's unsent
  // message reappears under a folder that is gone.
  // A draft key is `home:<workspace path>` or `session:<session file path>`
  // (stores/drafts.ts), so the path starts AFTER the first colon — remapping
  // the whole key would never match and the draft would be orphaned under a
  // folder that no longer exists.
  const drafts = s.get('drafts') ?? {}
  s.set(
    'drafts',
    Object.fromEntries(
      Object.entries(drafts).map(([key, draft]) => {
        const colon = key.indexOf(':')
        const nextKey =
          colon < 0 ? remap(key) : `${key.slice(0, colon + 1)}${remap(key.slice(colon + 1))}`
        return [
          nextKey,
          {
            ...draft,
            key: nextKey,
            ...(draft.workspacePath ? { workspacePath: remap(draft.workspacePath) } : {}),
          },
        ]
      }),
    ),
  )
}

export function recordWorkspace(path: string, name: string): void {
  const s = prefs()
  const now = Date.now()
  const workspaces = s.get('recentWorkspaces')
  // Stored resolved, so one folder has exactly one spelling here. Opening a
  // project through a symlink used to append a second entry for a folder
  // already listed, and the sidebar showed it as two groups listing the same
  // lanes — pi resolves the cwd, so both scanned one transcript directory.
  const real = realPathOrNull(path) ?? path
  // The last-opened workspace is always remembered (it drives launch resume),
  // but only real workspaces enter the recents list the sidebar orders by.
  if (!isWorktreeFolder(real)) {
    const entry: WorkspaceInfo = { path: real, name: basename(real) || name, lastOpenedAt: now }
    // Recency is metadata for launch recovery, not sidebar order. Preserve an
    // existing workspace's position; only a newly opened folder is appended.
    // Matched on the resolved path so an entry stored under an older spelling
    // is adopted rather than duplicated.
    const sameFolder = (workspace: WorkspaceInfo): boolean =>
      workspace.path === real || realPathOrNull(workspace.path) === real
    const index = workspaces.findIndex(sameFolder)
    const previous = index < 0 ? undefined : workspaces[index]?.path
    // Every other entry for this folder goes, not just the one being replaced.
    // Rewriting only the first match left the rest behind, and since the
    // rewrite makes that entry canonical, a list holding both spellings ended
    // up holding the SAME path twice — two identical sidebar groups that no
    // amount of de-duplication on read could tell apart from one.
    const next =
      index < 0
        ? [...workspaces, entry].slice(-20)
        : // `index` survives the filter: it is the FIRST match, so nothing
          // before it is dropped and its position does not shift.
          workspaces
            .filter((workspace, at) => at === index || !sameFolder(workspace))
            .map((workspace, at) => (at === index ? entry : workspace))
    s.set('recentWorkspaces', next)
    // Adopting an entry under a different spelling changes the key that
    // workspace-scoped state hangs off — an unsent draft is `home:<path>`.
    // Carry it across rather than stranding it under the old spelling.
    if (previous && previous !== real) repointStoredPaths([{ from: previous, to: real }])
  }
  s.set('lastWorkspacePath', real)
}
