import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import type { PlanRoutinesFact } from './plan-facts'

/**
 * The routines half of the fact scan: a copy of the backup's consistent
 * routines database with every `workspacePath` (each definition's, and each
 * run's snapshot of it) realpathed, so the service matches them to the
 * folders it imported. Also which session files a routine still owns, which
 * the sidebar hides and the migration leaves out like it.
 */

export const ROUTINES_IMPORT = 'routines.import.sqlite'

export interface RoutineScan {
  readonly fact: PlanRoutinesFact
  /** Session file → owned by a routine run that was never promoted. */
  readonly laneIndex: ReadonlySet<string>
}

type Row = { id: string; data: string }

/** Desktop's `RoutineRepository.laneIndex()` rule, read from the copy. */
const LANE_INDEX_SQL = `SELECT json_extract(data,'$.sessionPath') AS session_path FROM runs
  WHERE json_extract(data,'$.sessionPath') IS NOT NULL
    AND json_extract(data,'$.promoted') IS NOT 1`

/**
 * Writes `routines.import.sqlite` beside `consistent` in `backupDir` and
 * returns what the plan needs, or null when This Mac has no routines database.
 * Rerunning replaces the copy, so a crash part-way through converges.
 */
export function scanRoutines(input: {
  backupDir: string
  /** The backup's consistent copy, or null. */
  consistent: string | null
  realpath: (path: string) => string | null
}): RoutineScan | null {
  if (!input.consistent) return null
  const target = join(input.backupDir, ROUTINES_IMPORT)
  rmSync(target, { force: true })
  copyFileSync(input.consistent, target)
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(target)
  try {
    const workspaces = new Set<string>()
    const real = (path: unknown): string => {
      const value = typeof path === 'string' ? path : ''
      const resolved = input.realpath(value) ?? value
      workspaces.add(resolved)
      return resolved
    }
    const routines = db.prepare('SELECT id, data FROM routines ORDER BY id').all() as Row[]
    const runs = db.prepare('SELECT id, data FROM runs ORDER BY id').all() as Row[]
    const setRoutine = db.prepare(
      "UPDATE routines SET data = json_set(data, '$.workspacePath', ?) WHERE id = ?",
    )
    const setRun = db.prepare(
      "UPDATE runs SET data = json_set(data, '$.definition.workspacePath', ?) WHERE id = ?",
    )
    db.exec('BEGIN')
    for (const row of routines) {
      const data = JSON.parse(row.data) as { workspacePath?: unknown }
      setRoutine.run(real(data.workspacePath), row.id)
    }
    for (const row of runs) {
      const data = JSON.parse(row.data) as { definition?: { workspacePath?: unknown } }
      setRun.run(real(data.definition?.workspacePath), row.id)
    }
    db.exec('COMMIT')
    const owned = db.prepare(LANE_INDEX_SQL).all() as { session_path: string }[]
    return {
      fact: {
        database: target,
        workspaces: [...workspaces].sort(),
        routines: routines.length,
        runs: runs.length,
      },
      laneIndex: new Set(owned.map((row) => row.session_path)),
    }
  } finally {
    db.close()
  }
}

/** Routine rows in a routines database, read-only; G5 compares the live file with the copy. */
export function countRoutines(path: string): number {
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT count(*) AS n FROM routines').get() as { n: number }
    return Number(row.n)
  } finally {
    db.close()
  }
}
