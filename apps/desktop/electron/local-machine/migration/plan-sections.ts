import { join } from 'node:path'
import { normalizeLabel } from '@phosphor/shared/control-api'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import { isLaneMarker } from '@phosphor/shared/host-protocol-lane-marks'
import type {
  MigrationArchiveManifest,
  MigrationLaneItem,
  MigrationSection,
} from '@phosphor/shared/host-protocol-owner'
import { remoteLaneResourceKey } from '@phosphor/shared/remote-host'
import { sessionFileName } from '@phosphor/shared/visible-lanes'
import { repositoryIdForPath } from '@phosphor/session-runtime/host-local/repository-id'
import { sha256Hex } from '@phosphor/session-runtime/ops/redact'
import type { PlanArchiveFact, PlanFacts, PlanSessionFact } from './plan-facts'

/**
 * One mapper per `owner.migrate.import` section, from Desktop's facts to what
 * the service stages (D1 §3.7 "Mapping", with V-D1's corrections). Pure.
 */

type Section<S extends MigrationSection['section']> = Extract<MigrationSection, { section: S }>

/** A UUID (version 4 layout) derived from the migration and a key, so a plan is reproducible. */
export function plannedUuid(migrationId: string, kind: string, key: string): string {
  const h = sha256Hex(`${migrationId}\0${kind}\0${key}`)
  const variant = (8 | (parseInt(h[16]!, 16) & 3)).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Controls, bidi overrides and line separators: what `normalizeLabel` refuses in a title. */
const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g

/** `meta.name` or the first user text as a lane title of at most 80 characters, or null. */
export function laneTitle(session: Pick<PlanSessionFact, 'name' | 'firstUserText'>): string | null {
  const raw = session.name?.trim() ? session.name : session.firstUserText
  if (!raw) return null
  const flat = raw.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim()
  return normalizeLabel([...flat].slice(0, 80).join('').trimEnd())
}

/** An ISO time the protocol accepts (`toISOString` form), or `fallback`. */
function isoOr(value: string, fallback: number): string {
  const ms = Date.parse(value)
  return new Date(Number.isNaN(ms) ? fallback : ms).toISOString()
}

export function foldersSection(facts: PlanFacts): Section<'folders'> {
  return {
    section: 'folders',
    items: facts.folders.map((folder, order) => ({
      path: folder.path,
      name: folder.name,
      order,
      ...(folder.sandbox ? { sandbox: true as const } : {}),
    })),
    ...(facts.sandboxRoot ? { sandboxRoot: facts.sandboxRoot } : {}),
  }
}

/** Per-folder directives keep only folders that migrate, keyed by their realpath. */
export function policySection(facts: PlanFacts): Section<'policy'> {
  const { prefs } = facts
  const migrated = new Set(facts.folders.map((f) => f.path))
  const byFolder: Record<string, Section<'policy'>['agentDirectives']> = {}
  for (const [path, directives] of Object.entries(prefs.agentDirectivesByProject)) {
    const real = facts.folderRealpaths[path] ?? path
    if (migrated.has(real)) byFolder[real] = directives
  }
  return {
    section: 'policy',
    contextBudget: prefs.contextBudget,
    agentDirectives: prefs.agentDirectives,
    directivesByFolder: byFolder,
    autoNameLanes: prefs.lanes.autoName,
    contextFiles: { claude: prefs.contextFiles.claude, agents: prefs.contextFiles.agents },
    headroom: prefs.headroom.enabled,
  }
}

export function accountsSection(facts: PlanFacts): Section<'accounts'> {
  const accounts = facts.prefs.claudeAccounts ?? {
    accounts: [],
    mode: 'specific' as const,
    cursor: 0,
    cooldowns: {},
    bindings: {},
  }
  const known = new Set(accounts.accounts.map((a) => a.id))
  return {
    section: 'accounts',
    accountRoot: join(facts.userData, 'claude-accounts'),
    accounts: accounts.accounts,
    mode: accounts.mode,
    ...(accounts.pinnedId && known.has(accounts.pinnedId) ? { pinnedId: accounts.pinnedId } : {}),
    cursor: accounts.cursor,
    cooldowns: Object.fromEntries(
      Object.entries(accounts.cooldowns).filter(([id]) => known.has(id)),
    ),
    bindings: Object.fromEntries(
      Object.entries(facts.accountBindings).filter(([, id]) => known.has(id)),
    ),
  }
}

/** `existingId`: the lane the service already has for this file, which its import keeps. */
export function laneItem(
  migrationId: string,
  session: PlanSessionFact,
  existingId?: string,
): MigrationLaneItem {
  return {
    laneId: existingId ?? plannedUuid(migrationId, 'lane', session.path),
    sessionFile: session.path,
    cwd: session.cwd,
    rootPath: session.rootPath,
    worktree: session.worktree,
    title: laneTitle(session),
    branch: session.branch && isLaneBranchName(session.branch) ? session.branch : null,
    model: null,
    createdAt: isoOr(session.createdAt, session.mtimeMs),
    updatedAt: new Date(session.mtimeMs).toISOString(),
  }
}

/** Slop absorbing writes pi makes while a lane is on screen (client-ui `unseen.ts`). */
const SEEN_SLOP_MS = 2_000

/** Desktop's unseen rule: a seen marker exists AND activity is newer than it. */
function unread(facts: PlanFacts, session: PlanSessionFact): boolean {
  const seenAt = facts.prefs.seenSessions[session.path]
  const activity = Date.parse(session.lastActivityAt)
  return seenAt !== undefined && !Number.isNaN(activity) && activity > seenAt + SEEN_SLOP_MS
}

export function marksSection(
  facts: PlanFacts,
  lanes: readonly PlanSessionFact[],
): Section<'marks'> {
  const pinned = new Set(facts.prefs.pinnedSessions)
  const items = lanes.flatMap((lane) => {
    const marker = facts.prefs.laneMarkers[lane.path]
    const item = {
      sessionFile: lane.path,
      ...(pinned.has(lane.path) ? { pinned: true as const } : {}),
      ...(marker !== undefined && isLaneMarker(marker) ? { marker } : {}),
      ...(unread(facts, lane) ? { unread: true as const } : {}),
    }
    return Object.keys(item).length > 1 ? [item] : []
  })
  // Desktop records rewinds by file name; the service takes the files' paths.
  const byName = new Map(facts.sessions.map((s) => [sessionFileName(s.path), s.path]))
  const rewound: Record<string, string> = {}
  for (const [from, to] of Object.entries(facts.prefs.rewoundSessions)) {
    const fromPath = byName.get(from)
    const toPath = byName.get(to)
    if (fromPath && toPath) rewound[fromPath] = toPath
  }
  return { section: 'marks', items, rewound }
}

/** A draft key Desktop stored for the archived lane, re-keyed to the lane it becomes. */
function draftKeyFor(
  metadata: Record<string, unknown> | undefined,
  machineId: string,
  laneId: string,
) {
  const key = metadata?.draftKey
  return typeof key === 'string' && key.startsWith('session:')
    ? remoteLaneResourceKey(machineId, laneId)
    : undefined
}

/** V-D1.E3: a new lane id, the folder's repository id, and the recorded identity byte-equal. */
export function archiveManifest(
  facts: PlanFacts,
  archive: PlanArchiveFact,
): MigrationArchiveManifest {
  const { record } = archive
  const id = plannedUuid(facts.migrationId, 'archive', record.id)
  const draftKey = draftKeyFor(record.metadata, facts.machineId, id)
  return {
    version: 1,
    id,
    title: record.title,
    cwd: record.cwd,
    archivedAt: record.archivedAt,
    state: record.state,
    ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
    ...(record.transcript === undefined ? {} : { transcript: record.transcript }),
    ...(record.identity ? { identity: record.identity } : {}),
    ...(record.repository === undefined ? {} : { repository: record.repository }),
    ...(record.checkout ? { checkout: record.checkout } : {}),
    metadata: {
      repositoryId: repositoryIdForPath(archive.folder ?? record.repository ?? record.cwd),
      ...(draftKey ? { draftKey } : {}),
    },
  }
}

export function archivesSection(facts: PlanFacts): Section<'archives'> {
  return { section: 'archives', manifests: facts.archives.map((a) => archiveManifest(facts, a)) }
}

export function artifactsSection(facts: PlanFacts): Section<'artifacts'> {
  return { section: 'artifacts', sourceDir: join(facts.userData, 'artifacts') }
}

export function routinesSection(facts: PlanFacts): Section<'routines'> | null {
  if (!facts.routines) return null
  return {
    section: 'routines',
    database: facts.routines.database,
    workspaces: [...facts.routines.workspaces].sort(),
  }
}
