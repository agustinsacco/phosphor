/**
 * The daemon's record of Desktop's one-time move (`owner_migrations`), the
 * sections it staged (`owner_migration_staging`) and the begin snapshot that
 * abort restores. Each call opens its own short-lived connection to
 * state.sqlite, beside the lane store's, so the store's API stays unchanged;
 * the store prepares every read afresh, so its next read sees these writes.
 */
import { closeSync, constants, fsyncSync, openSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { MigrationState } from '@phosphor/shared/host-protocol-owner'
import { loadSqlite } from '../lanes/sqlite'
import { prepareStateFile } from '../lanes/state-dir'

/** The bookkeeping tables abort never restores: they record the abort itself. */
const MIGRATION_TABLES = ['owner_migrations', 'owner_migration_staging'] as const

export type StoredMigrationState = Exclude<MigrationState, 'none'>

export interface StoredMigration {
  readonly migrationId: string
  readonly state: StoredMigrationState
  readonly desktopVersion: string
  readonly merge: boolean
  /**
   * The standby marker was removed after this commit. A committed row without
   * it rolls forward at the next start; one with it never touches a later standby.
   */
  readonly left: boolean
}

export interface StagedSection {
  readonly digest: string
  readonly payload: string
}

const STATES: readonly StoredMigrationState[] = ['staged', 'committed', 'aborted']

function migrationFromRow(row: Record<string, unknown>): StoredMigration {
  const state = STATES.find((s) => s === row.state)
  const detail: unknown = typeof row.detail === 'string' ? JSON.parse(row.detail) : null
  if (!state || typeof row.migration_id !== 'string' || !detail || typeof detail !== 'object')
    throw new Error('owner_migrations row is not readable')
  const fields = detail as Record<string, unknown>
  if (typeof fields.desktopVersion !== 'string')
    throw new Error('owner_migrations row is not readable')
  return {
    migrationId: row.migration_id,
    state,
    desktopVersion: fields.desktopVersion,
    merge: fields.merge === true,
    left: fields.left === true,
  }
}

const detailOf = (m: Pick<StoredMigration, 'desktopVersion' | 'merge' | 'left'>) =>
  JSON.stringify({ desktopVersion: m.desktopVersion, merge: m.merge, left: m.left })

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

/** One connection's view of the migration tables. Every write is one transaction. */
export class MigrationRecords {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(migrationId: string): StoredMigration | null {
    const row = this.db
      .prepare('SELECT * FROM owner_migrations WHERE migration_id=?')
      .get(migrationId)
    return row ? migrationFromRow(row) : null
  }

  /** Every row in `state`, oldest first. */
  inState(state: StoredMigrationState): StoredMigration[] {
    return this.db
      .prepare('SELECT * FROM owner_migrations WHERE state=? ORDER BY began_at,migration_id')
      .all(state)
      .map(migrationFromRow)
  }

  begin(migration: Pick<StoredMigration, 'migrationId' | 'desktopVersion' | 'merge'>): void {
    const now = this.now()
    this.db
      .prepare('INSERT INTO owner_migrations VALUES (?,?,?,?,?)')
      .run(migration.migrationId, 'staged', now, now, detailOf({ ...migration, left: false }))
  }

  staged(migrationId: string, section: string): StagedSection | null {
    const row = this.db
      .prepare(
        'SELECT digest,payload FROM owner_migration_staging WHERE migration_id=? AND section=?',
      )
      .get(migrationId, section)
    return row && typeof row.digest === 'string' && typeof row.payload === 'string'
      ? { digest: row.digest, payload: row.payload }
      : null
  }

  stage(migrationId: string, section: string, staged: StagedSection): void {
    this.db
      .prepare('INSERT INTO owner_migration_staging VALUES (?,?,?,?,?)')
      .run(migrationId, section, staged.digest, staged.payload, this.now())
  }

  private setState(migration: StoredMigration, state: StoredMigrationState, left: boolean): void {
    this.db
      .prepare('UPDATE owner_migrations SET state=?,updated_at=?,detail=? WHERE migration_id=?')
      .run(state, this.now(), detailOf({ ...migration, left }), migration.migrationId)
    this.db
      .prepare('DELETE FROM owner_migration_staging WHERE migration_id=?')
      .run(migration.migrationId)
  }

  /** THE commit point: durable once this returns (WAL with `synchronous=FULL`). */
  commit(migration: StoredMigration): void {
    this.transaction(() => this.setState(migration, 'committed', false))
  }

  markLeft(migration: StoredMigration): void {
    this.transaction(() => this.setState(migration, migration.state, true))
  }

  /** Copies the whole database into `path`, an empty private file, and syncs it. */
  snapshot(path: string): void {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600))
    this.db.prepare('VACUUM INTO ?').run(path)
    const file = openSync(path, constants.O_RDONLY)
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
  }

  /**
   * Puts every table except the migration's own back to the snapshot at
   * `path`, and marks `migration` aborted, in one transaction.
   */
  restore(path: string, migration: StoredMigration): void {
    this.db.prepare('ATTACH ? AS snapshot').run(path)
    try {
      const names = (schema: string) =>
        this.db
          .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`)
          .all()
          .map((row) => String(row.name))
          .filter(
            (name) => !name.startsWith('sqlite_') && !MIGRATION_TABLES.some((t) => t === name),
          )
      const kept = new Set(names('snapshot'))
      const tables = names('main')
      this.transaction(() => {
        this.db.exec('PRAGMA defer_foreign_keys=ON')
        for (const table of tables) this.db.exec(`DELETE FROM main.${quoted(table)}`)
        for (const table of tables.filter((t) => kept.has(t)))
          this.db.exec(`INSERT INTO main.${quoted(table)} SELECT * FROM snapshot.${quoted(table)}`)
        this.setState(migration, 'aborted', migration.left)
      })
    } finally {
      this.db.exec('DETACH snapshot')
    }
  }
}

/** Runs `fn` over a fresh connection to `<stateDirectory>/state.sqlite`, then closes it. */
export async function withMigrationRecords<T>(
  stateDirectory: string,
  uid: number | undefined,
  now: () => number,
  fn: (records: MigrationRecords) => T,
): Promise<T> {
  const path = prepareStateFile(stateDirectory, uid)
  const sqlite = await loadSqlite()
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;')
    return fn(new MigrationRecords(db, now))
  } finally {
    db.close()
  }
}
