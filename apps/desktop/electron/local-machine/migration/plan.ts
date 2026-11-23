import { join } from 'node:path'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { parseMigrationImport, type MigrationSection } from '@phosphor/shared/host-protocol-owner'
import { repositoryIdForPath } from '@phosphor/session-runtime/host-local/repository-id'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'
import { canonicalJson, sha256Hex } from '@phosphor/session-runtime/ops/redact'
import type { ImportStep } from './journal'
import type { PlanFacts, PlanSessionFact } from './plan-facts'
import {
  accountsSection,
  archivesSection,
  artifactsSection,
  foldersSection,
  laneItem,
  marksSection,
  policySection,
  routinesSection,
} from './plan-sections'

/**
 * Step 3: the migration plan, `plan.json` in the backup folder. A pure
 * function of the facts (`plan-scan.ts`), so it is reproducible: the same
 * facts give the same plan and hash. It holds every section the service will
 * stage, the lane id each session file becomes, and what the gates check.
 */

export const PLAN_FILE = 'plan.json'
const PLAN_MAX_BYTES = 64 * 1024 * 1024

export type PlanSections = {
  readonly [S in ImportStep]?: Extract<MigrationSection, { section: S }>
}

export interface PlanCounts {
  readonly folders: number
  readonly lanes: number
  readonly pins: number
  readonly markers: number
  readonly archives: number
  readonly accounts: number
  readonly routines: number
  readonly runs: number
}

/**
 * Why the plan refuses to migrate. `limits` keeps This Mac in-app with a
 * notice (N6); every other refusal is a gate failure with that code.
 */
export type PlanRefusal = 'limits' | 'folder-spellings' | 'routine-folder' | `invalid-${ImportStep}`

export interface MigrationPlan {
  readonly version: 1
  readonly migrationId: string
  readonly machineId: string
  readonly sections: PlanSections
  /** Session file → the lane id it becomes; M4 re-keys device state with it. */
  readonly laneIds: Readonly<Record<string, string>>
  /** Folder realpath → repository id. */
  readonly repositoryIds: Readonly<Record<string, string>>
  /** G3's ten spot lanes, by session file. */
  readonly spots: readonly string[]
  /** The files the session witness covers (G8). */
  readonly witness: readonly string[]
  readonly expected: PlanCounts
  readonly refusals: readonly PlanRefusal[]
}

export const sectionHash = (section: MigrationSection): string => sha256Hex(canonicalJson(section))

export const planHash = (plan: MigrationPlan): string => sha256Hex(canonicalJson(plan))

/** The lanes that migrate: what the sidebar shows, in a folder that migrates. */
function plannedLanes(facts: PlanFacts): PlanSessionFact[] {
  const folders = new Set(facts.folders.map((f) => f.path))
  return facts.sessions
    .filter((s) => s.visible && folders.has(s.rootPath))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Ten deterministic spot checks (G3): largest, newest, oldest, a worktree
 * lane, a removed-worktree lane, a sandbox lane, two pinned, then the rest
 * by path. Archived and routine lanes are not sidebar lanes, so not here.
 */
export function spotLanes(facts: PlanFacts, lanes: readonly PlanSessionFact[]): string[] {
  const sandboxes = new Set(facts.folders.filter((f) => f.sandbox).map((f) => f.path))
  const pinned = new Set(facts.prefs.pinnedSessions)
  const by = (score: (s: PlanSessionFact) => number) =>
    [...lanes].sort((a, b) => score(b) - score(a) || (a.path < b.path ? -1 : 1))
  const picks = [
    by((s) => s.size)[0],
    by((s) => s.mtimeMs)[0],
    by((s) => -Date.parse(s.createdAt) || 0)[0],
    lanes.find((s) => s.worktree && !s.cwdMissing),
    lanes.find((s) => s.cwdMissing),
    lanes.find((s) => sandboxes.has(s.rootPath)),
    ...lanes.filter((s) => pinned.has(s.path)).slice(0, 2),
    ...lanes,
  ]
  const spots: string[] = []
  for (const pick of picks) {
    if (spots.length === 10) break
    if (pick && !spots.includes(pick.path)) spots.push(pick.path)
  }
  return spots
}

function refusalsOf(facts: PlanFacts, lanes: number, sections: PlanSections): PlanRefusal[] {
  const refusals: PlanRefusal[] = []
  if (facts.folders.length > HOST_LIMITS.repositoriesPerHost || lanes > HOST_LIMITS.lanesPerHost)
    refusals.push('limits')
  if (facts.duplicateFolders.length > 0) refusals.push('folder-spellings')
  const folders = new Set(facts.folders.map((f) => f.path))
  if (facts.routines?.workspaces.some((path) => !folders.has(path))) refusals.push('routine-folder')
  for (const [name, section] of Object.entries(sections) as [ImportStep, MigrationSection][]) {
    const wire = { migrationId: facts.migrationId, hash: sectionHash(section), ...section }
    if (!parseMigrationImport(wire)) refusals.push(`invalid-${name}`)
  }
  return refusals
}

export function buildPlan(facts: PlanFacts): MigrationPlan {
  const lanes = plannedLanes(facts)
  const lanesSection = {
    section: 'lanes' as const,
    items: lanes.map((lane) => laneItem(facts.migrationId, lane)),
  }
  const marks = marksSection(facts, lanes)
  const routines = routinesSection(facts)
  const sections: PlanSections = {
    folders: foldersSection(facts),
    policy: policySection(facts),
    accounts: accountsSection(facts),
    lanes: lanesSection,
    marks,
    archives: archivesSection(facts),
    artifacts: artifactsSection(facts),
    ...(routines ? { routines } : {}),
  }
  const archived = facts.archives.flatMap(({ record }) =>
    record.transcript ? [record.transcript, `${record.transcript}.archived`] : [],
  )
  return {
    version: 1,
    migrationId: facts.migrationId,
    machineId: facts.machineId,
    sections,
    laneIds: Object.fromEntries(lanesSection.items.map((i) => [i.sessionFile, i.laneId])),
    repositoryIds: Object.fromEntries(
      facts.folders.map((f) => [f.path, repositoryIdForPath(f.path)]),
    ),
    spots: spotLanes(facts, lanes),
    witness: [...new Set([...lanes.map((l) => l.path), ...archived])].sort(),
    expected: {
      folders: facts.folders.length,
      lanes: lanes.length,
      pins: marks.items.filter((i) => i.pinned).length,
      markers: marks.items.filter((i) => i.marker !== undefined).length,
      archives: facts.archives.length,
      accounts: sections.accounts?.accounts.length ?? 0,
      routines: facts.routines?.routines ?? 0,
      runs: facts.routines?.runs ?? 0,
    },
    refusals: refusalsOf(facts, lanes.length, sections),
  }
}

export function writePlan(backupDir: string, plan: MigrationPlan): string {
  atomicRecord(join(backupDir, PLAN_FILE), plan, 0o600)
  return planHash(plan)
}

/** The plan a previous run of step 3 wrote, or null. */
export function readPlan(backupDir: string): MigrationPlan | null {
  try {
    const plan = JSON.parse(
      readBounded(join(backupDir, PLAN_FILE), PLAN_MAX_BYTES),
    ) as MigrationPlan
    return plan.version === 1 ? plan : null
  } catch {
    return null
  }
}
