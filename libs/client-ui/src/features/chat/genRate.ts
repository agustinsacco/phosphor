/**
 * Generation throughput: the output tokens per second the model is actually
 * giving us right now.
 *
 * Why a trailing window and not the run average: an agent run is generation
 * threaded with tool calls, and an average over the whole run reports 3 tok/s
 * while a 90 tok/s model sits in a 40-second `npm test`. That figure describes
 * the wait, not the model. So this measures the last few seconds of the stream
 * and reports NOTHING at all once tokens have stopped moving — the strip loses
 * the number instead of lying with it.
 *
 * Input is session-cumulative OUTPUT tokens (`stats.tokens.output`, which
 * `liveStats` keeps current from `message_update` deltas plus each
 * `message_end`), so this measures deltas of a running total and needs no
 * per-message bookkeeping. Reasoning counts as output, which is right: a long
 * thinking block is the model generating, and the rate holds through it.
 *
 * Providers that report usage only when a message completes (`openai-codex`)
 * advance in jumps, so their rate is coarser but never invented — a session
 * that never shows any token movement shows nothing here. See liveStats.ts for
 * the same problem on the context meter.
 */

export interface GenSample {
  /** Wall-clock ms. */
  t: number
  /** Cumulative output tokens as of `t`. */
  tokens: number
}

export interface GenRate {
  tokensPerSecond: number
  /** Output tokens generated across `spanMs`. */
  tokens: number
  /** How long the stretch measured lasts. */
  spanMs: number
}

/** Longest stretch measured: long enough to steady the figure, short enough to track a change. */
export const GEN_WINDOW_MS = 10_000
/** Below this the arithmetic is noise, so the readout stays off. */
const MIN_SPAN_MS = 2_000
/** No tokens for this long ends the readout: the model is not generating. */
const STALL_MS = 4_000
/** Samples older than this are dropped; the window needs far fewer. */
const KEEP_MS = 60_000

/**
 * Record one reading into `samples`, in place.
 *
 * A caller samples on every usage delta AND once a second while the run lives,
 * so the newest sample is near `now` and a gap in token movement is visible as
 * a run of equal readings rather than missing data.
 *
 * A reading that goes BACKWARDS is dropped rather than trusted: a
 * `get_session_stats` poll can re-seed `base` a hair under what the live
 * overlay had already shown, and a negative delta would read as a stall that
 * never happened.
 */
export function recordGenSample(samples: GenSample[], t: number, tokens: number): void {
  const last = samples[samples.length - 1]
  if (last && tokens < last.tokens) return
  if (last && last.t === t) {
    samples[samples.length - 1] = { t, tokens }
  } else {
    samples.push({ t, tokens })
  }
  const floor = t - KEEP_MS
  while (samples.length > 2 && samples[0]!.t < floor) samples.shift()
}

/**
 * Tokens per second over the trailing window, or null when there is nothing
 * honest to report — no stream yet, a window too short to divide by, or no
 * token movement for {@link STALL_MS}.
 *
 * A pause shorter than the stall floor stays inside the window and slows the
 * figure, which is the truth of it: a 2-second gap between two of pi's
 * per-tool-hop messages really did make that second slower.
 */
export function genRateFrom(samples: GenSample[], now: number): GenRate | null {
  const newest = samples[samples.length - 1]
  if (!newest || samples.length < 2 || newest.tokens <= 0) return null
  // The trailing edge is the newest reading, not `now`: a caller whose last
  // sample is long overdue measures the stream, not its own timer.
  if (now - newest.t > KEEP_MS) return null

  let startIndex = samples.length - 1
  let idleMs = 0
  for (let i = samples.length - 1; i > 0; i--) {
    const gap = samples[i]!.t - samples[i - 1]!.t
    if (samples[i]!.tokens - samples[i - 1]!.tokens <= 0) {
      idleMs += gap
      if (idleMs >= STALL_MS) break
    } else {
      idleMs = 0
    }
    if (newest.t - samples[i - 1]!.t > GEN_WINDOW_MS) break
    startIndex = i - 1
  }

  const start = samples[startIndex]!
  const spanMs = newest.t - start.t
  const tokens = newest.tokens - start.tokens
  if (spanMs < MIN_SPAN_MS || tokens <= 0) return null
  return { tokensPerSecond: tokens / (spanMs / 1000), tokens, spanMs }
}

/** Forget everything (a new run starts its own timer and its own rate). */
export function resetGenSamples(samples: GenSample[]): void {
  samples.length = 0
}
