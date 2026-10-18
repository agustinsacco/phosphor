import { realpathSync } from 'node:fs'
import { basename, sep } from 'node:path'
import type { AppPrefs, WorkspaceInfo } from '@shared/models'
import { repointPath, resumeTargetRemoved, type PathMove } from '../prefs-utils'
import type { PrefsGetter } from './backend'

/**
 * True for a path inside a repo's internal worktree folder
 * (`<repo>/.phosphor/worktrees/<name>`). A worktree is a branch of an existing
 * workspace, not a workspace itself, so it must never persist as one.
 */
// `.pidex` is the pre-rename (2026-09-08) folder; existing lanes still live there.
const WORKTREE_SEGMENT = /[/\\]\.(?:phosphor|pidex)[/\\]worktrees[/\\]/
export function isWorktreeFolder(path: string): boolean {
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
export function resolvedOrSame(path: string | undefined): string | undefined {
  return path === undefined ? undefined : (realPathOrNull(path) ?? path)
}

export function setRecentWorkspaces(
  getStore: PrefsGetter,
  workspaces: AppPrefs['recentWorkspaces'],
): void {
  const s = getStore()
  const previous = (s.get('recentWorkspaces') ?? []).map((workspace) => workspace.path)
  s.set('recentWorkspaces', workspaces)
  // A removed project must not come back on the next launch through resume.
  const next = workspaces.map((workspace) => workspace.path)
  if (resumeTargetRemoved(previous, next, s.get('lastWorkspacePath'), realPathOrNull)) {
    s.delete('lastWorkspacePath')
    s.delete('lastSessionPath')
  }
}

/**
 * Rewrite every persisted path that sits at or under one of `moves`.
 *
 * Left alone after a sandbox rename, each of these names something that no
 * longer exists: the next launch resumes nothing, and every pin, marker and
 * unseen-badge on that sandbox's chats silently drops. The matching rule (and
 * why it is a prefix) is `repointPath`.
 */
export function repointStoredPaths(getStore: PrefsGetter, moves: readonly PathMove[]): void {
  const s = getStore()
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

export function recordWorkspace(getStore: PrefsGetter, path: string, name: string): void {
  const s = getStore()
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
    if (previous && previous !== real) repointStoredPaths(getStore, [{ from: previous, to: real }])
  }
  s.set('lastWorkspacePath', real)
}

/**
 * Remember the session to reopen on next launch. `undefined` clears it, so
 * closing a session means the app lands on that workspace's home screen
 * rather than reopening something the user deliberately left.
 */
export function setLastSession(getStore: PrefsGetter, sessionPath: string | undefined): void {
  const s = getStore()
  if (sessionPath) s.set('lastSessionPath', sessionPath)
  else s.delete('lastSessionPath')
}

export function setCollapsedWorkspaces(getStore: PrefsGetter, paths: string[]): void {
  getStore().set('collapsedWorkspaces', paths)
}
