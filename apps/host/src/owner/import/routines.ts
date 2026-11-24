/**
 * The `routines` section: Desktop's routines, run history and settings, row
 * for row, into `<state>/routines/state.sqlite`. Rows keep their bytes, so
 * enabled state, schedule cursor and the trust acknowledgement carry over
 * (same machine, same user). The scheduler is not running in standby; it
 * starts with the lanes after commit, so nothing fires twice.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ROUTINE_LIMITS } from '@phosphor/shared/host-protocol-routines'
import type { Routine, RoutineRun } from '@phosphor/shared/routines'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { loadRoutineSqlite } from '@phosphor/session-runtime/routines/sqlite'
import { prepareStateDirectory, prepareStateFile } from '../../lanes/state-dir'
import type { MigrationImporter } from '../migrate'
import { refuseImport, type ImportPorts } from './ports'

export const ROUTINE_REFUSALS = {
  folder: 'A routine’s folder was not imported. Import the folders first.',
  tooMany: `This Mac has more routines than the Phosphor service can hold (${ROUTINE_LIMITS.routines}).`,
  taken: 'A routine on this Mac has the same id as a different one on the service.',
  newer: 'The routines database is newer than this Phosphor service.',
} as const

type Row = Record<string, string | number>
interface Rows {
  routines: Row[]
  runs: Row[]
  settings: Row[]
}
type KeptIds = { readonly [T in keyof Rows]: readonly string[] }

const KEYS: { readonly [T in keyof Rows]: string } = {
  routines: 'id',
  runs: 'id',
  settings: 'key',
}

function readRows(db: DatabaseSync): Rows {
  const all = (sql: string) => db.prepare(sql).all() as Row[]
  return {
    routines: all('SELECT id,data FROM routines ORDER BY id'),
    runs: all('SELECT id,routine_id,occurrence,created_at,data FROM runs ORDER BY created_at,id'),
    settings: all('SELECT key,value FROM settings ORDER BY key'),
  }
}

function openSource(path: string): Rows {
  const { DatabaseSync } = loadRoutineSqlite()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1) throw refuseImport('bad-request', ROUTINE_REFUSALS.newer)
    return readRows(db)
  } finally {
    db.close()
  }
}

/** Each definition, also the one a run snapshotted, belongs to an imported folder. */
function requireFolders(rows: Rows, workspaces: ReadonlySet<string>) {
  const paths = [
    ...rows.routines.map((r) => (JSON.parse(String(r.data)) as Routine).workspacePath),
    ...rows.runs.map((r) => (JSON.parse(String(r.data)) as RoutineRun).definition.workspacePath),
  ]
  if (paths.some((path) => !workspaces.has(path)))
    throw refuseImport('bad-request', ROUTINE_REFUSALS.folder)
}

/** Rows the daemon lacks. An identical row is skipped; a different one under the same key refuses. */
function addedRows(target: Rows, source: Rows): Rows {
  const pick = (table: 'routines' | 'runs') => {
    const have = new Map(target[table].map((r) => [String(r.id), r]))
    return source[table].filter((row) => {
      const old = have.get(String(row.id))
      if (old && JSON.stringify(old) !== JSON.stringify(row))
        throw refuseImport('forbidden', ROUTINE_REFUSALS.taken)
      return !old
    })
  }
  const runs = pick('runs')
  const occurrences = new Set(target.runs.map((r) => String(r.occurrence)))
  if (runs.some((r) => occurrences.has(String(r.occurrence))))
    throw refuseImport('forbidden', ROUTINE_REFUSALS.taken)
  const keys = new Set(target.settings.map((r) => String(r.key)))
  return {
    routines: pick('routines'),
    runs,
    settings: source.settings.filter((r) => !keys.has(String(r.key))),
  }
}

const active = (rows: Row[]) =>
  rows.filter((r) => !(JSON.parse(String(r.data)) as Routine).archived).length

function insertRows(db: DatabaseSync, rows: Rows) {
  const routine = db.prepare('INSERT INTO routines(id,data) VALUES (?,?)')
  const run = db.prepare(
    'INSERT INTO runs(id,routine_id,occurrence,created_at,data) VALUES (?,?,?,?,?)',
  )
  const setting = db.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const r of rows.routines) routine.run(r.id!, r.data!)
    for (const r of rows.runs) run.run(r.id!, r.routine_id!, r.occurrence!, r.created_at!, r.data!)
    for (const r of rows.settings) setting.run(r.key!, r.value!)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function routineImporter(ports: ImportPorts): MigrationImporter<'routines'> {
  const directory = join(ports.stateDirectory, 'routines')
  /** The Host's routines database, made by its own repository, on a connection of ours. */
  function withTarget<T>(fn: (db: DatabaseSync) => T): T {
    prepareStateDirectory(directory, ports.uid)
    const path = prepareStateFile(directory, ports.uid)
    new RoutineRepository(path).close()
    const { DatabaseSync } = loadRoutineSqlite()
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
      return fn(db)
    } finally {
      db.close()
    }
  }
  return {
    async apply(section, { store }) {
      const folders = new Set(store.listRepositories().map((r) => r.path))
      const workspaces = new Set(section.workspaces)
      if ([...workspaces].some((w) => !folders.has(w)))
        throw refuseImport('bad-request', ROUTINE_REFUSALS.folder)
      const source = openSource(section.database)
      requireFolders(source, workspaces)
      withTarget((db) => {
        const target = readRows(db)
        const added = addedRows(target, source)
        if (active(target.routines) + active(added.routines) > ROUTINE_LIMITS.routines)
          throw refuseImport('too-large', ROUTINE_REFUSALS.tooMany)
        insertRows(db, added)
        ports.log('owner.migrate.routines', {
          routines: added.routines.length,
          runs: added.runs.length,
        })
      })
    },
    async snapshot(into) {
      const kept = withTarget((db): KeptIds => {
        const rows = readRows(db)
        const ids = (table: keyof Rows) => rows[table].map((r) => String(r[KEYS[table]]))
        return { routines: ids('routines'), runs: ids('runs'), settings: ids('settings') }
      })
      await writeFile(join(into, 'routines.kept.json'), JSON.stringify(kept), {
        mode: 0o600,
        flag: 'wx',
      })
    },
    async restore(from) {
      const kept = JSON.parse(await readFile(join(from, 'routines.kept.json'), 'utf8')) as KeptIds
      withTarget((db) => {
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const [table, key] of Object.entries(KEYS)) {
            const keep = new Set(kept[table as keyof Rows])
            const remove = db.prepare(`DELETE FROM ${table} WHERE ${key}=?`)
            for (const row of readRows(db)[table as keyof Rows])
              if (!keep.has(String(row[key]))) remove.run(row[key]!)
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
    },
  }
}
