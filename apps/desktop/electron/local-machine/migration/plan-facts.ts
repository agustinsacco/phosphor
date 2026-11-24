import type { AppPrefs } from '@phosphor/shared/models'
import type { ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'

/**
 * What the plan is built from: everything Desktop knows about This Mac's
 * lanes, read once by `plan-scan.ts`. The plan itself (`plan.ts`) is a pure
 * function of these facts, so the same facts always give the same plan and
 * the same hash.
 */

/** The prefs the plan maps; the rest of `config.json` stays with the device or is legacy. */
export type PlanPrefs = Pick<
  AppPrefs,
  | 'pinnedSessions'
  | 'laneMarkers'
  | 'seenSessions'
  | 'rewoundSessions'
  | 'agentDirectives'
  | 'agentDirectivesByProject'
  | 'contextBudget'
  | 'contextFiles'
  | 'headroom'
  | 'lanes'
  | 'claudeAccounts'
>

export interface PlanFolderFact {
  /** The folder's realpath, which the service names it by. */
  readonly path: string
  readonly name: string
  readonly sandbox: boolean
}

export interface PlanSessionFact {
  /** The session file, as Desktop's prefs key it. */
  readonly path: string
  readonly sessionId: string
  readonly cwd: string
  /** The realpath of the recent folder whose sidebar group lists it. */
  readonly rootPath: string
  readonly worktree: boolean
  /** The session header's timestamp. */
  readonly createdAt: string
  readonly mtimeMs: number
  readonly lastActivityAt: string
  readonly name?: string
  readonly firstUserText?: string
  readonly branch: string | null
  readonly size: number
  /** The lane's folder is gone (a removed worktree whose conversation the sidebar keeps). */
  readonly cwdMissing: boolean
  /** The sidebar shows it: not a folded rewind predecessor, not a routine's lane. */
  readonly visible: boolean
  /** A routine run's lane: the service hides it by the routine, not by a lane. */
  readonly routine: boolean
}

export interface PlanArchiveFact {
  readonly record: ArchiveRecord
  /** The realpath of the migrated folder it belongs to, or null when none is. */
  readonly folder: string | null
}

export interface PlanRoutinesFact {
  /** The consistent copy with every `workspacePath` realpathed, inside the backup folder. */
  readonly database: string
  /** Every workspace a definition names, realpathed. */
  readonly workspaces: readonly string[]
  readonly routines: number
  readonly runs: number
}

export interface PlanFacts {
  readonly migrationId: string
  /** The service's machine id: lane keys on this Mac embed it. */
  readonly machineId: string
  readonly userData: string
  readonly prefs: PlanPrefs
  /** Recent folders in sidebar order, de-duplicated by realpath. */
  readonly folders: readonly PlanFolderFact[]
  /** Each recent folder's recorded path → its realpath. */
  readonly folderRealpaths: Readonly<Record<string, string>>
  /** Recent folders that named an already listed folder by another spelling. */
  readonly duplicateFolders: readonly string[]
  /** Every session file scanned in those folders, visible or not. */
  readonly sessions: readonly PlanSessionFact[]
  /** Desktop's archive manifests as stored, each with its folder. */
  readonly archives: readonly PlanArchiveFact[]
  readonly sandboxRoot: string | null
  readonly routines: PlanRoutinesFact | null
  /** Account bindings whose session file still exists (Desktop's `tidy` rule). */
  readonly accountBindings: Readonly<Record<string, string>>
}
