// Frozen readers from 684cb3478. Only the userData location and Electron main are injected.
import { basename, join } from 'node:path'
import Conf from 'conf'
import { isWorktreeFolder } from '@phosphor/shared/worktree-segment'
import { canonicalPaths, pruneRewoundSessions, visibleWorkspaces } from '../../../prefs-utils'
import { realPathOrNull, resolvedOrSame } from '../../../prefs/workspaces'
import {
  DEFAULT_APP_PREFS,
  DEFAULT_MAINTENANCE_PREFS,
  DEFAULT_MODEL_PICKS,
  normalizeAgentDirectives,
  normalizeLanePrefs,
  type MaintenancePrefs,
  type AppPrefs,
} from '@shared/models'
import { normalizeFeedbackPrefs } from '@shared/feedback'
import { normalizeVoicePrefs } from '@shared/voice'
import { normalizeWritingPrefs } from '@shared/writing'
import { normalizeContextFilePrefs } from '@shared/context-files'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
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
export function baseGetPrefs(userData: string): AppPrefs {
  const s = new Conf<AppPrefs>({ cwd: userData, configName: 'config', defaults: DEFAULT_APP_PREFS })
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
    // Host folder keys (`host:…`) are not paths; only This Mac's folders resolve.
    collapsedWorkspaces: canonicalPaths(s.get('collapsedWorkspaces') ?? [], (path) =>
      path.startsWith('host:') ? null : realPathOrNull(path),
    ),
    seenSessions: s.get('seenSessions') ?? {},
    laneMarkers: s.get('laneMarkers') ?? {},
    // Normalized on read as well as write: prefs are user-editable JSON, and
    // these numbers reach a prompt, a git ref and a filesystem path.
    lanes: normalizeLanePrefs(s.get('lanes')),
    maintenance: normalizeMaintenancePrefs(s.get('maintenance')),
    fonts: { ...DEFAULT_APP_PREFS.fonts, ...s.get('fonts') },
    agentDirectives: normalizeAgentDirectives(s.get('agentDirectives')),
    // Merged per entry, not passed through: a stored override predates any
    // directive block added later, and an absent key must mean "take the
    // default", never "off". Only the keys the user actually set win.
    agentDirectivesByProject: Object.fromEntries(
      Object.entries(s.get('agentDirectivesByProject') ?? {}).map(([path, directives]) => [
        path,
        normalizeAgentDirectives(directives),
      ]),
    ),
    retiredDirectives: stringRecord(s.get('retiredDirectives')),
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
function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

// Packaged startRoutines + RoutineRepository's v1 open and list, without a scheduler.
export function baseRoutines(userData: string) {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(join(userData, 'routines.sqlite'))
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    const version = db.prepare('PRAGMA user_version').get()!.user_version
    if (version !== 0 && version !== 1)
      throw new Error('Routines database is newer than this runtime. Upgrade the runtime.')
    db.exec(`
      CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, occurrence TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_history ON runs(routine_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS runs_active ON runs(created_at)
        WHERE json_extract(data, '$.status') IN ('queued','running');
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
    `)
    return db
      .prepare('SELECT data FROM routines')
      .all()
      .map((row) => JSON.parse(row.data as string) as unknown)
  } finally {
    db.close()
  }
}
