/**
 * The lanes the start-up model repair read without finding a model, each
 * with how the read ended (`none` or `capped`) and its session file's
 * `size:mtimeMs` then. They are `lane_prefs` rows under `model_scan` in
 * `state.sqlite`: no file of their own in the state folder, so purge removes
 * them with the database on every version, and a lane's row goes with the
 * lane. Every other reader of `lane_prefs` selects its own key. The memo only
 * saves work: a value it does not know reads as nothing remembered.
 */
import type { DatabaseSync } from 'node:sqlite'
import { isUuid } from '@phosphor/shared/control-api'
import { loadSqlite } from '../sqlite'
import { prepareStateFile } from '../state-dir'

const KEY = 'model_scan'
const VALUE = /^(none|capped):\d{1,16}:\d{1,16}(\.\d{1,9})?$/
const remembered = (laneId: unknown, value: unknown): value is string =>
  isUuid(String(laneId)) && typeof value === 'string' && VALUE.test(value)

async function withStateDb<T>(
  directory: string,
  uid: number | undefined,
  fn: (db: DatabaseSync) => T,
): Promise<T> {
  const sqlite = await loadSqlite()
  const db = new sqlite.DatabaseSync(prepareStateFile(directory, uid))
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    return fn(db)
  } finally {
    db.close()
  }
}

export function readModelScans(
  directory: string,
  uid: number | undefined,
): Promise<Map<string, string>> {
  return withStateDb(directory, uid, (db) => {
    const rows = db.prepare('SELECT lane_id, value FROM lane_prefs WHERE key=?').all(KEY)
    return new Map(
      rows.flatMap((row) =>
        remembered(row.lane_id, row.value) ? [[String(row.lane_id), row.value] as const] : [],
      ),
    )
  })
}

/** Replaces every remembered lane with `scanned`; a lane no longer stored is left out. */
export function writeModelScans(
  directory: string,
  uid: number | undefined,
  scanned: ReadonlyMap<string, string>,
): Promise<void> {
  return withStateDb(directory, uid, (db) => {
    const insert = db.prepare(
      `INSERT INTO lane_prefs(lane_id, key, value) SELECT lane_id, ?, ? FROM lanes WHERE lane_id=?`,
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM lane_prefs WHERE key=?').run(KEY)
      for (const [laneId, value] of scanned)
        if (remembered(laneId, value)) insert.run(KEY, value, laneId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}
