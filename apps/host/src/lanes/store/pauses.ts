import type { DatabaseSync } from 'node:sqlite'
import { check, integer, uuid } from '../validation'

/** Whether the lane was idle when the pause took hold, or its turn was aborted by Abort now. */
export type LanePauseWas = 'idle' | 'aborted'

export interface LanePauseRow {
  laneId: string
  /** Milliseconds since the epoch. */
  pausedAt: number
  was: LanePauseWas
}

/**
 * `lane_pauses` (created by `ADDITIVE_SCHEMA`): the lanes a service update
 * paused, so the next daemon shows them paused until Continue (`lane.resume`)
 * or a prompt. A deleted lane's row goes with it (`ON DELETE CASCADE`).
 */
export class LanePauseRows {
  constructor(private readonly db: DatabaseSync) {}

  /** Every stored row; a row that does not read back as written is skipped. */
  list(): LanePauseRow[] {
    const rows = this.db
      .prepare('SELECT lane_id, paused_at, was FROM lane_pauses ORDER BY paused_at, lane_id')
      .all()
    return rows.flatMap((row) => {
      const { lane_id: laneId, paused_at: pausedAt, was } = row
      if (typeof laneId !== 'string' || typeof pausedAt !== 'number') return []
      if (was !== 'idle' && was !== 'aborted') return []
      return [{ laneId, pausedAt, was }]
    })
  }

  /** Stores the rows in one transaction, replacing any earlier row for the same lane. */
  record(rows: readonly LanePauseRow[]): void {
    for (const row of rows) {
      uuid(row.laneId)
      integer(row.pausedAt)
      check(row.was === 'idle' || row.was === 'aborted')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare(
        `INSERT INTO lane_pauses (lane_id, reason, paused_at, was) VALUES (?, 'service-update', ?, ?)
        ON CONFLICT(lane_id) DO UPDATE SET paused_at=excluded.paused_at, was=excluded.was`,
      )
      for (const row of rows) insert.run(row.laneId, row.pausedAt, row.was)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Deletes the lanes' rows; answers how many there were. */
  remove(laneIds: readonly string[]): number {
    const remove = this.db.prepare('DELETE FROM lane_pauses WHERE lane_id=?')
    let removed = 0
    for (const laneId of laneIds) removed += Number(remove.run(laneId).changes)
    return removed
  }
}
