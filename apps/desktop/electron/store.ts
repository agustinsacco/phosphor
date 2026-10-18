import { basename } from 'node:path'
import { prefs } from './prefs/backend'
import * as drafts from './prefs/drafts'
import * as workspaces from './prefs/workspaces'
import { isWorktreeFolder, realPathOrNull, resolvedOrSame } from './prefs/workspaces'
import {
  canonicalPaths,
  type PathMove,
  pruneLaneMarkers,
  pruneRewoundSessions,
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
} from '@shared/models'
import { type FeedbackPrefs, normalizeFeedbackPrefs } from '@shared/feedback'
import { normalizeVoicePrefs, type VoicePrefs } from '@shared/voice'
import { isValidContextBudgetValue } from '@shared/context-budget'
import {
  normalizeContextFilePrefs,
  type ContextFileKind,
  type ContextFilePrefs,
} from '@shared/context-files'
import { normalizeWritingPrefs, type WritingPrefs } from '@shared/writing'

export { realPathOrNull } from './prefs/workspaces'
export { getRemoteClients, setRemoteClients } from './prefs/backend'

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
    rewoundSessions: pruneRewoundSessions(s.get('rewoundSessions') ?? {}),
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
    voice: normalizeVoicePrefs(s.get('voice')),
    feedback: normalizeFeedbackPrefs(s.get('feedback')),
    // User-editable JSON: a non-string here would throw in every reader's
    // `.trim()`, the settings tab and the context meter included. '' is the
    // default budget, the same as unset.
    contextBudget: stringOrEmpty(s.get('contextBudget')),
    contextFiles: normalizeContextFilePrefs(s.get('contextFiles')),
    writing: normalizeWritingPrefs(s.get('writing')),
    drafts: s.get('drafts') ?? {},
  }
}

export function setHeadroomPrefs(headroom: AppPrefs['headroom']): void {
  prefs().set('headroom', headroom)
}

export function setVoicePrefs(voice: VoicePrefs): void {
  prefs().set('voice', normalizeVoicePrefs(voice))
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

export const setDraft = (draft: ComposerDraftRecord): string[] => drafts.setDraft(prefs, draft)
export const clearDraft = (key: string): string[] => drafts.clearDraft(prefs, key)
export const setDrafts = (records: Record<string, ComposerDraftRecord>): void =>
  drafts.setDrafts(prefs, records)

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

/** See AppPrefs.compactionResetChecked. */
export function isCompactionResetChecked(): boolean {
  return prefs().get('compactionResetChecked') === true
}

export function markCompactionResetChecked(): void {
  prefs().set('compactionResetChecked', true)
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * See AppPrefs.contextBudget — stored trimmed; '' means the default budget.
 * The settings field validates as the user types; this is the same check at
 * the process boundary, so nothing it would reject reaches the prefs file.
 */
export function setContextBudget(value: string): void {
  const trimmed = typeof value === 'string' ? value.trim() : null
  if (trimmed === null || (trimmed !== '' && !isValidContextBudgetValue(trimmed))) {
    throw new Error('Invalid context budget.')
  }
  prefs().set('contextBudget', trimmed)
}

/** See AppPrefs.contextFiles. Sets one kind; the other keeps its stored value. */
export function setContextFile(kind: ContextFileKind, included: boolean): ContextFilePrefs {
  if (kind !== 'claude' && kind !== 'agents') throw new Error('Invalid context file kind.')
  const next = {
    ...normalizeContextFilePrefs(prefs().get('contextFiles')),
    [kind]: included === true,
  }
  prefs().set('contextFiles', next)
  return next
}

/** See AppPrefs.writing. Read alone because a send checks it, and getPrefs resolves paths. */
export function getWritingPrefs(): WritingPrefs {
  return normalizeWritingPrefs(prefs().get('writing'))
}

export function setWritingPrefs(value: WritingPrefs): WritingPrefs {
  const next = normalizeWritingPrefs(value)
  prefs().set('writing', next)
  return next
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

export const setRecentWorkspaces = (recent: AppPrefs['recentWorkspaces']): void =>
  workspaces.setRecentWorkspaces(prefs, recent)

export function setSessionOrder(paths: string[]): void {
  prefs().set('sessionOrder', [...new Set(paths)])
}

export function setPinnedSessions(paths: string[]): void {
  prefs().set('pinnedSessions', paths)
}

/**
 * Keyed by file name, so a folder rename (`repointStoredPaths`) has nothing to
 * rewrite here: the record keeps matching the moved transcripts as is.
 */
export function setRewoundSessions(record: Record<string, string>): void {
  prefs().set('rewoundSessions', pruneRewoundSessions(record))
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

export const setCollapsedWorkspaces = (paths: string[]): void =>
  workspaces.setCollapsedWorkspaces(prefs, paths)

export const setLastSession = (sessionPath: string | undefined): void =>
  workspaces.setLastSession(prefs, sessionPath)

export function setTheme(theme: ThemePreference): void {
  prefs().set('theme', theme)
}

export const repointStoredPaths = (moves: readonly PathMove[]): void =>
  workspaces.repointStoredPaths(prefs, moves)
export const recordWorkspace = (path: string, name: string): void =>
  workspaces.recordWorkspace(prefs, path, name)
