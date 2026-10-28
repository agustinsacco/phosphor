/**
 * A lane's pin and marker, kept by its Host so every client shows the same ones.
 *
 * `marker`: a glyph, `''` for an explicit "no marker", or (in a change) `null`
 * to forget the choice so the lane falls back to its derived auto marker.
 */
export interface LaneMarksChange {
  pinned?: boolean
  marker?: string | null
}
export type LaneMarksOp = { type: 'lane.marks' } & LaneMarksChange

/**
 * UTF-16 units in one marker. The picker's longest glyph (a tag-sequence flag)
 * is 14; this leaves room for longer ZWJ sequences without admitting text.
 */
export const LANE_MARKER_MAX_UNITS = 32

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** C0, DEL, C1 and the line and paragraph separators. */
const control = (unit: number) =>
  unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029
const high = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/** An explicit marker: `''` (none on purpose) or one glyph the picker could produce. */
export function isLaneMarker(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > LANE_MARKER_MAX_UNITS) return false
  for (let i = 0; i < v.length; i++) {
    const unit = v.charCodeAt(i)
    if (control(unit) || low(unit)) return false
    // A high surrogate must pair with the low one after it; unpaired halves never store.
    if (high(unit) && !low(v.charCodeAt(++i))) return false
  }
  return true
}

/** Exactly `type`, `pinned` and `marker`, with at least one of the two. */
export function parseLaneMarksOp(v: unknown): LaneMarksOp | null {
  if (
    !record(v) ||
    v.type !== 'lane.marks' ||
    !Object.keys(v).every((key) => key === 'type' || key === 'pinned' || key === 'marker') ||
    (v.pinned === undefined && v.marker === undefined) ||
    (v.pinned !== undefined && typeof v.pinned !== 'boolean') ||
    (v.marker !== undefined && v.marker !== null && !isLaneMarker(v.marker))
  )
    return null
  return {
    type: 'lane.marks',
    ...(v.pinned === undefined ? {} : { pinned: v.pinned }),
    ...(v.marker === undefined ? {} : { marker: v.marker }),
  }
}

/** A lane's marks after `change`: pinned only when true, marker only when chosen. */
export function withLaneMarks<T extends { pinned?: boolean; marker?: string }>(
  lane: T,
  change: LaneMarksChange,
): T {
  const { pinned: _pinned, marker: _marker, ...rest } = lane
  const pinned = change.pinned ?? lane.pinned === true
  const marker = change.marker === undefined ? lane.marker : (change.marker ?? undefined)
  return {
    ...rest,
    ...(pinned ? { pinned: true } : {}),
    ...(marker === undefined ? {} : { marker }),
  } as T
}
