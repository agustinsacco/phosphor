import type { DatabaseSync } from 'node:sqlite'
import {
  LANE_MARKER_MAX_UNITS,
  isLaneMarker,
  parseLaneMarksOp,
  withLaneMarks,
  type LaneMarksChange,
} from '@phosphor/shared/host-protocol-lane-marks'
import { check } from '../validation'
import type { Row } from './rows'
import type { StoredLane } from './types'

export type { LaneMarksChange } from '@phosphor/shared/host-protocol-lane-marks'

const controls = Array.from({ length: 31 }, (_, i) => i + 1)
  .concat(127)
  .join(',')
/**
 * A lane's pin and marker. Created on every open, outside SCHEMA, so an existing
 * state file gains it without a user_version bump: `phosphor update --rollback`
 * leaves an older Host that ignores the table. A lane row's marks go with it.
 */
export const LANE_MARKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS lane_marks (
  lane_id TEXT PRIMARY KEY NOT NULL REFERENCES lanes(lane_id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
  marker TEXT CHECK(marker IS NULL OR (length(marker)<=${LANE_MARKER_MAX_UNITS} AND marker NOT GLOB '*[' || char(${controls}) || ']*')),
  CHECK(pinned=1 OR marker IS NOT NULL)
) STRICT;
`

/** Every lane read: the lane row with its marks, if any. */
export const LANE_SELECT =
  'SELECT lanes.*,lane_marks.pinned AS mark_pinned,lane_marks.marker AS mark_marker FROM lanes LEFT JOIN lane_marks USING(lane_id)'

/** A pin only when set; a marker only when chosen. An invalid stored mark is dropped. */
export function marksFromRow(row: Row): Pick<StoredLane, 'pinned' | 'marker'> {
  return {
    ...(Number(row.mark_pinned) === 1 ? { pinned: true as const } : {}),
    ...(isLaneMarker(row.mark_marker) ? { marker: row.mark_marker } : {}),
  }
}

/** Store `change` over the lane's current marks. A lane with neither keeps no row. */
export function writeLaneMarks(db: DatabaseSync, lane: StoredLane, change: LaneMarksChange): void {
  check(parseLaneMarksOp({ ...change, type: 'lane.marks' }) !== null)
  const next = withLaneMarks(lane, change)
  if (next.pinned !== true && next.marker === undefined) {
    db.prepare('DELETE FROM lane_marks WHERE lane_id=?').run(lane.laneId)
    return
  }
  db.prepare(
    `INSERT INTO lane_marks VALUES (?,?,?)
    ON CONFLICT(lane_id) DO UPDATE SET pinned=excluded.pinned,marker=excluded.marker`,
  ).run(lane.laneId, next.pinned === true ? 1 : 0, next.marker ?? null)
}
