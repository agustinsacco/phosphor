import type { DatabaseSync } from 'node:sqlite'
import { check, integer, uuid } from '../validation'

/** Additive, rollback-readable schema. Old Hosts may prune tombstones, never fail their startup. */
export const LANE_ARCHIVES_SCHEMA = `CREATE TABLE IF NOT EXISTS lane_archive_ids (
  lane_id TEXT PRIMARY KEY REFERENCES lanes(lane_id) ON DELETE CASCADE
)`

export class LaneArchiveRows {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly limit: number,
  ) {}
  has(id: string): boolean {
    uuid(id)
    return this.db.prepare('SELECT 1 FROM lane_archive_ids WHERE lane_id=?').get(id) !== undefined
  }
  ownsCwd(cwd: string, except?: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM lanes JOIN lane_archive_ids USING(lane_id)
      WHERE cwd=? AND lane_id != ? LIMIT 1`,
        )
        .get(cwd, except ?? '') !== undefined
    )
  }
  mark(id: string): void {
    uuid(id)
    this.transaction(() => {
      check(this.db.prepare('SELECT 1 FROM lanes WHERE lane_id=?').get(id) !== undefined)
      if (!this.has(id))
        check(Number(this.db.prepare('SELECT count(*) AS n FROM lane_archive_ids').get()?.n) < 1000)
      this.db.prepare('INSERT OR IGNORE INTO lane_archive_ids VALUES (?)').run(id)
      this.db
        .prepare('UPDATE lanes SET removed_at=COALESCE(removed_at,?) WHERE lane_id=?')
        .run(this.now(), id)
    })
    // Deliberately no onLaneRemoved hook: archived attachments are retained.
  }
  restore(id: string): void {
    uuid(id)
    this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT lanes.removed_at FROM lanes JOIN repositories ON repositories.id=lanes.repository_id
        WHERE lane_id=? AND repositories.active=1`,
        )
        .get(id)
      check(row !== undefined)
      if (row.removed_at !== null) {
        const count = this.db
          .prepare('SELECT count(*) AS n FROM lanes WHERE removed_at IS NULL')
          .get()?.n
        check(Number(count) < this.limit)
        this.db
          .prepare(
            'UPDATE lanes SET removed_at=NULL,controller_client_id=NULL,controller_label=NULL,fence=fence+1 WHERE lane_id=?',
          )
          .run(id)
      }
      this.db.prepare('DELETE FROM lane_archive_ids WHERE lane_id=?').run(id)
    })
  }
  forget(id: string): void {
    uuid(id)
    this.db.prepare('DELETE FROM lane_archive_ids WHERE lane_id=?').run(id)
  }
  private transaction(run: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

export const REMOVED_LANE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export function pruneRemoved(db: DatabaseSync, now: number, limit: number) {
  integer(now)
  const unarchived = 'lane_id NOT IN (SELECT lane_id FROM lane_archive_ids)'
  db.prepare(`DELETE FROM lanes WHERE removed_at < ? AND ${unarchived}`).run(
    now - REMOVED_LANE_TTL_MS,
  )
  db.prepare(
    `DELETE FROM lanes WHERE lane_id IN (SELECT lane_id FROM lanes
    WHERE removed_at IS NOT NULL AND ${unarchived} ORDER BY removed_at DESC,lane_id DESC LIMIT -1 OFFSET ?)`,
  ).run(limit)
}
