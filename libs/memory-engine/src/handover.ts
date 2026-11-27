/**
 * Moving a Brain file to another owner on the same machine (docs/brain-handover.md): the
 * consistent copy, its schema upgrade, its checks, and the tombstone that keeps every older
 * build away from the legacy path once the move starts. The live store (`./store`) is not
 * involved: nothing here prunes, re-indexes or bumps a revision.
 */
import { randomUUID } from 'node:crypto'
import type { backup } from 'node:sqlite'
import { initialize } from './schema'
import { brainSchemaVersion } from './handover-digest'
import type { SqliteConstructor, SqliteDatabase } from './types'

export {
  brainColumns,
  brainHandoverDigest,
  brainSchemaVersion,
  compareBrainHandover,
} from './handover-digest'
export { exerciseBrainCopy } from './handover-exercise'
export type { BrainCopyExercise } from './handover-exercise'
export type {
  BrainColumns,
  BrainHandoverCounts,
  BrainHandoverDigest,
  BrainTableDigest,
} from './handover-digest'

/** Schemas a handover accepts; older files would start a new knowledge store, so they stay. */
export const BRAIN_HANDOVER_SCHEMAS = [7, 8] as const

/**
 * The tombstone's `user_version`. Every engine since the first stored Brain refuses a version
 * above its own ("requires a newer application") instead of resetting the file.
 */
export const BRAIN_TOMBSTONE_VERSION = 1_000_000

export class BrainHandoverRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrainHandoverRefused'
  }
}

/**
 * A WAL-consistent copy of the Brain at `source` into `target` (which must not exist), through
 * SQLite's online backup. Returns the copy's schema version.
 */
export async function backupBrainDatabase(
  sqlite: { readonly DatabaseSync: SqliteConstructor; readonly backup: typeof backup },
  source: string,
  target: string,
): Promise<number> {
  const db = new sqlite.DatabaseSync(source, { readOnly: true, timeout: 2000 })
  try {
    const version = brainSchemaVersion(db)
    if (version === BRAIN_TOMBSTONE_VERSION)
      throw new BrainHandoverRefused('This Brain has already moved.')
    if (!BRAIN_HANDOVER_SCHEMAS.some((v) => v === version))
      throw new BrainHandoverRefused(`A version ${version} Brain cannot move.`)
    await sqlite.backup(db, target)
    return version
  } finally {
    db.close()
  }
}

/** `integrity_check` and `foreign_key_check` problems; empty when the file is sound. */
export function brainIntegrityProblems(db: SqliteDatabase): string[] {
  const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
  const problems = integrity
    .map((row) => row.integrity_check)
    .filter((line) => line !== 'ok')
    .slice(0, 20)
  const foreign = db.prepare('PRAGMA foreign_key_check').all() as { table: string }[]
  if (foreign.length > 0)
    problems.push(`foreign keys: ${[...new Set(foreign.map((row) => row.table))].join(',')}`)
  return problems
}

/**
 * Upgrades a staged copy in place with the engine's own steps, without the retention pass the
 * live store runs on open. Refuses anything but v7 or v8.
 */
export function upgradeBrainDatabase(db: SqliteDatabase): { from: number; to: number } {
  const from = brainSchemaVersion(db)
  if (!BRAIN_HANDOVER_SCHEMAS.some((v) => v === from))
    throw new BrainHandoverRefused(`A version ${from} Brain cannot move.`)
  initialize({ db, now: Date.now, id: randomUUID })
  return { from, to: brainSchemaVersion(db) }
}

/** The lane transcripts a Brain file names: read sources, plus Brain Agent run transcripts. */
export function brainSourceSessions(db: SqliteDatabase): {
  readonly lanes: readonly string[]
  readonly agent: readonly string[]
} {
  const paths = (sql: string) =>
    (db.prepare(sql).all() as { path: string }[]).map((row) => row.path)
  return {
    lanes: paths(
      `SELECT session_path AS path FROM jobs UNION SELECT session_path FROM extractions
       ORDER BY 1`,
    ),
    agent: paths(
      'SELECT DISTINCT session_path AS path FROM agent_runs WHERE session_path IS NOT NULL ORDER BY 1',
    ),
  }
}

/**
 * Writes a tombstone Brain file at `path` (which must not exist): WAL mode, so opening it changes
 * nothing, and `user_version` above every engine's, so every build refuses it. The migration id
 * says where the Brain went.
 */
export function writeBrainTombstone(
  Database: SqliteConstructor,
  path: string,
  migrationId: string,
): void {
  const db = new Database(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE brain_moved(migration_id TEXT NOT NULL)')
    db.prepare('INSERT INTO brain_moved VALUES (?)').run(migrationId)
    db.exec(`PRAGMA user_version = ${BRAIN_TOMBSTONE_VERSION}`)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/** The migration id a tombstone at `path` names, or null for any other file. */
export function brainTombstone(Database: SqliteConstructor, path: string): string | null {
  let db: SqliteDatabase
  try {
    db = new Database(path, { readOnly: true })
  } catch {
    return null
  }
  try {
    if (brainSchemaVersion(db) !== BRAIN_TOMBSTONE_VERSION) return null
    const row = db.prepare('SELECT migration_id AS id FROM brain_moved').get() as
      { id: string } | undefined
    return row?.id ?? null
  } catch {
    return null
  } finally {
    db.close()
  }
}
