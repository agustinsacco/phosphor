import type { TranscriptRow } from './transcriptRows'

/**
 * Leading space for a transcript row — the single owner of vertical rhythm.
 *
 * The reference (Claude Desktop) uses *one* step for the whole stream and
 * encodes grouping with colour and weight: gray tool lines, full-contrast
 * prose. Phosphor previously did the opposite — a boundary-aware 8/16px gap here
 * *plus* per-block margins inside each item (tool group `my-2`, thinking
 * `my-1.5`, divider `my-1`, markdown paragraphs) — so 4–6 independent sources
 * of space stacked and the effective gap varied by block type even when this
 * function returned the same class.
 *
 * Measured in the e2e harness: a collapsed tool row's wrapper was 63px tall for
 * ~20px of text (16px `pt-4` + 2px `pb-0.5` + 16px `my-2` + 8px row padding).
 * With one owner it is ~36px, and the transcript reads as grouped blocks
 * instead of an evenly-spaced list.
 *
 * One step at EVERY non-first boundary — the sole exception is the first row,
 * which needs no leading gap. Uniform steps keep each row symmetric: the gap
 * above a message or tool group always equals the gap below it. Grouping is
 * carried by ink, not air: the activity card's border and surface, the user
 * bubble, and weight/colour contrast. A previous two-step scheme (4px inside
 * a turn, 12px after the final activity card) left tool groups 4px from the
 * text above and 12px from the text below; `buildTranscriptRows` merging tool
 * rounds into one row made the in-turn step redundant anyway.
 */

/**
 * The one vertical step (pt-2 = 8px). The literal IS the single source.
 *
 * It was 12px, which measured fine in isolation and read as loose in a real
 * transcript: prose sets its own 1.65 line-height, so ~4px of half-leading
 * sits above the first line and below the last one, and the eye adds that to
 * whatever this returns. 8px of margin plus that leading lands on the ~16px
 * the reference actually shows between a paragraph and the group under it.
 */
export const STREAM_GAP = 'pt-2'

/**
 * Leading class for a boundary: no gap before the first row, one step
 * otherwise — identical above and below every message and tool group. The
 * row's own kind no longer matters, only whether a previous row exists.
 */
export function spacingFor(previous: TranscriptRow | undefined): string {
  return previous ? STREAM_GAP : ''
}
