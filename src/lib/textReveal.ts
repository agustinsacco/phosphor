/**
 * Pacing for the streaming-text reveal.
 *
 * Measured problem, not a hunch: the Claude Code provider delivers prose in
 * ~93-character chunks every ~550ms (12 deltas for a 1,121-char answer;
 * gap p50 544ms, p90 594ms), because the CLI batches the API's SSE stream
 * into its own cadence. pi-native providers stream token-sized deltas tens
 * of milliseconds apart. Rendering each chunk on arrival is what made
 * Claude-provider turns land in harsh slabs — Claude desktop receives the
 * same coarse chunks and reads smoothly because the client paces the reveal.
 *
 * So Phosphor paces it too: text drains from the (exact, untouched) store into
 * view at a rate that aims to empty the backlog in about one upstream gap.
 * The rate is proportional to the backlog — big chunk arrives, reveal speeds
 * up; backlog nearly empty, it eases out — so the reveal never falls behind
 * a fast producer and never crawls after a slow one. Pure math here, no
 * timers and no React, so it can be unit-tested against recorded cadences.
 */

/** Reveal state carried between animation ticks. Floats, deliberately —
 *  rounding per tick at 2-3 chars/frame would drop fractional progress. */
export interface RevealState {
  /** Characters currently visible (fractional; floor before slicing). */
  visible: number
  /** Timestamp of the previous tick, ms. */
  lastTick: number
}

/**
 * Drain the backlog in roughly this long. Matched to the measured ~550ms
 * inter-chunk gap: shorter and the reveal finishes early then stalls at a
 * blinking cursor until the next chunk; much longer and it lags the model.
 */
const CATCHUP_MS = 700
/** Once the turn has settled, finish what's left quickly — but not as a pop. */
const SETTLE_CATCHUP_MS = 150
/** Floor so the ease-out tail still finishes (chars per ms). */
const MIN_RATE = 0.08
/** Ceiling so an enormous paste-like chunk cannot blur past readability. */
const MAX_RATE = 8

/**
 * Advance the reveal by one tick.
 *
 * @param streaming false once the block/turn has settled — the remainder
 *   drains on the fast schedule instead of snapping, so the last chunk of a
 *   turn does not pop in after an otherwise smooth reveal.
 */
export function advanceReveal(
  state: RevealState,
  targetLength: number,
  now: number,
  streaming: boolean,
): RevealState {
  const dt = Math.max(0, now - state.lastTick)
  const remaining = targetLength - state.visible
  if (remaining <= 0) {
    // Text can only grow; a shrink means the block was replaced — snap.
    return { visible: targetLength, lastTick: now }
  }
  const rate = Math.min(
    MAX_RATE,
    Math.max(MIN_RATE, remaining / (streaming ? CATCHUP_MS : SETTLE_CATCHUP_MS)),
  )
  return {
    visible: Math.min(targetLength, state.visible + rate * dt),
    lastTick: now,
  }
}

/**
 * Slice that never splits a surrogate pair.
 *
 * A reveal boundary lands at an arbitrary UTF-16 index, and cutting between
 * the halves of an astral-plane character (emoji, some CJK) renders a lone
 * surrogate as U+FFFD for a frame. Backing up one unit is invisible; the
 * replacement character is not.
 */
export function sliceAtCodePoint(text: string, length: number): string {
  const n = Math.max(0, Math.min(text.length, Math.floor(length)))
  if (n === 0 || n >= text.length) return n >= text.length ? text : ''
  const last = text.charCodeAt(n - 1)
  // High surrogate at the cut: its partner is at index n. Exclude both.
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, n - 1)
  return text.slice(0, n)
}
