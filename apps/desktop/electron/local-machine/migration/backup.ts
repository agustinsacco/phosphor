import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'

/**
 * Step 2: a verified copy of every userData file the migration reads or the
 * quarantine changes, in `<userData>/daemon-migration/backup-<id>/`. Sessions,
 * sandboxes, `claude-accounts/`, `brain/`, `artifacts/` and `drafts/` are never
 * written by the migration, so they are not copied. The routines database is
 * copied twice: raw with its `-wal` and `-shm`, and consistent through
 * SQLite's own `VACUUM INTO`, which is what the plan and the import read.
 * Kept until the release that removes the in-app runtime; never pruned here.
 */

export const BACKUP_MANIFEST = 'backup.json'
export const ROUTINES_CONSISTENT = 'routines.consistent.sqlite'

export interface BackupEntry {
  /** Relative to both userData and the backup folder. */
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

export interface BackupManifest {
  readonly version: 1
  readonly migrationId: string
  readonly entries: readonly BackupEntry[]
  /** The consistent routines copy in the backup folder, or null when there is no database. */
  readonly routines: BackupEntry | null
}

export interface BackupInput {
  readonly userData: string
  readonly backupDir: string
  readonly migrationId: string
  /** `routines.sqlite`, or `routines-dev.sqlite` where Desktop's own rule picks it. */
  readonly routinesFile: string
}

export const backupDirFor = (migrationDir: string, migrationId: string) =>
  join(migrationDir, `backup-${migrationId}`)

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function readIfFile(path: string): Buffer | null {
  try {
    if (!statSync(path).isFile()) return null
    return readFileSync(path)
  } catch (error) {
    if (errnoIs(error, 'ENOENT', 'ENOTDIR')) return null
    throw error
  }
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch (error) {
    if (errnoIs(error, 'ENOENT', 'ENOTDIR')) return []
    throw error
  }
}

/** The userData files the backup covers, relative, in a fixed order. */
export function backupNames(userData: string, routinesFile: string): string[] {
  return [
    'config.json',
    'session-maintenance.json',
    'remote-clients.json',
    ...listJson(join(userData, 'lane-archive')).map((name) => `lane-archive/${name}`),
    routinesFile,
    `${routinesFile}-wal`,
    `${routinesFile}-shm`,
  ]
}

/** Copies `name` unless the backup already holds the same bytes, then re-reads it to verify. */
function copyVerified(input: BackupInput, name: string): BackupEntry | null {
  const source = readIfFile(join(input.userData, name))
  if (!source) return null
  const digest = sha256(source)
  const target = join(input.backupDir, name)
  if (readIfFile(target)?.equals(source) !== true) {
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 })
    copyFileSync(join(input.userData, name), target)
  }
  const copied = readIfFile(target)
  if (!copied || sha256(copied) !== digest) throw new BackupFailed('backup-verify')
  return { name, bytes: source.length, sha256: digest }
}

/** A consistent copy of the routines database; redone whenever the step reruns. */
function consistentRoutines(input: BackupInput): BackupEntry | null {
  const source = join(input.userData, input.routinesFile)
  if (!readIfFile(source)) return null
  const target = join(input.backupDir, ROUTINES_CONSISTENT)
  rmSync(target, { force: true })
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.prepare('VACUUM INTO ?').run(target)
  } finally {
    db.close()
  }
  const copied = readIfFile(target)
  if (!copied) throw new BackupFailed('backup-routines')
  return { name: ROUTINES_CONSISTENT, bytes: copied.length, sha256: sha256(copied) }
}

/** A backup step failure; `code` is the journal's failure code. */
export class BackupFailed extends Error {
  constructor(readonly code: string) {
    super(`The migration backup failed (${code}).`)
    this.name = 'BackupFailed'
  }
}

/**
 * Makes or completes the backup and returns its manifest, written last. A
 * rerun after a crash skips files whose copy already matches and redoes the
 * consistent routines copy.
 */
export function backupUserData(input: BackupInput): BackupManifest {
  mkdirSync(input.backupDir, { recursive: true, mode: 0o700 })
  const entries = backupNames(input.userData, input.routinesFile).flatMap(
    (name) => copyVerified(input, name) ?? [],
  )
  const manifest: BackupManifest = {
    version: 1,
    migrationId: input.migrationId,
    entries,
    routines: consistentRoutines(input),
  }
  atomicRecord(join(input.backupDir, BACKUP_MANIFEST), manifest, 0o600)
  return manifest
}

/** The manifest a finished backup wrote, or null. */
export function readBackupManifest(backupDir: string): BackupManifest | null {
  const bytes = readIfFile(join(backupDir, BACKUP_MANIFEST))
  if (!bytes) return null
  try {
    const value = JSON.parse(bytes.toString('utf8')) as BackupManifest
    return value.version === 1 && Array.isArray(value.entries) ? value : null
  } catch {
    return null
  }
}

/** The backed-up copy of `name` (for example `config.json`), parsed as JSON, or null. */
export function readBackupJson(backupDir: string, name: string): unknown {
  const bytes = readIfFile(join(backupDir, name))
  if (!bytes) return null
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return null
  }
}
