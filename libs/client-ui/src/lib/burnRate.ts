/**
 * Runaway-burn detection from session token stats.
 *
 * A provider can bill enormously while accomplishing nothing: a tool loop that
 * re-sends context it already delivered spends its whole budget on input and
 * cache tokens, and the only visible symptom is that the numbers climb. On
 * 2026-08-21 that pattern consumed ~46M tokens across three concurrent Phosphor
 * sessions in roughly twenty minutes, peaking at 3.5M tokens/minute, and
 * nothing in the stack remarked on it.
 *
 * Two signals together, because rate alone would flag any large-context
 * session for the crime of being large:
 *
 *   - RATE. Healthy minutes in the incident data ran 27k–200k billed tokens;
 *     the runaway burst ran 1.4M–3.5M. The thresholds sit in the gap.
 *   - CACHEWRITE ACCELERATION. Within the trailing window, the rate at which
 *     cacheWrite accumulates in the second half over the same rate in the
 *     first half.
 *
 * Why cacheWrite acceleration is the discriminator. A replay loop re-sends
 * context it has already delivered, so the prompt *prefix* changes on every
 * turn, the cache misses, and cacheWrite climbs — and climbs faster as the
 * replayed transcript grows. Healthy accumulation appends to a prefix that is
 * already cached, so cacheWrite per turn shrinks toward just the newly added
 * content. The pathology is compounding growth, and this measures exactly that.
 *
 * Why YIELD (output as a share of billed) was dropped as a gate. It does not
 * separate a loop from legitimate read-heavy work. Measured on three real
 * sessions:
 *
 *   session   yield   reality
 *   01a02bb0  0.50%   genuine runaway; the resume prompt grew 51x
 *   01a024eb  1.15%   10-hour mixed session, real work plus some replay
 *   01a02c8e  0.93%   completely healthy: read 12 large files in 13 calls
 *
 * The healthy session's yield sits *between* the two bad ones. Replaying
 * 01a02c8e's real timeline through the yield-gated detector shows "elevated"
 * from t+65s onward on a session that did exactly what was asked. A detector
 * that fires on healthy work gets ignored when it matters, so yield is now
 * reported for context and gates nothing.
 *
 * Over the same two clean timelines, replayed at every polling density from
 * one sample per model call up to thirteen, acceleration never exceeded 0.91
 * on the healthy session in any window that also cleared the rate gate, and
 * never fell below 2.86 on the runaway one. See `burnRate.test.ts`, which
 * holds both timelines as real measurements.
 */

/** One observation of a session's cumulative counters. */
export interface BurnSample {
  /** Epoch milliseconds. */
  at: number
  /** Cumulative billed tokens: input + output + cacheRead + cacheWrite. */
  billed: number
  /** Cumulative output tokens. */
  output: number
  /** Cumulative cache-write tokens. */
  cacheWrite: number
}

export interface BurnAssessment {
  /** Billed tokens per minute across the sampled window. */
  tokensPerMinute: number
  /**
   * Output tokens as a fraction (0–1) of billed tokens in the window.
   * Reported for context in the UI; deliberately not part of `level`.
   */
  yield: number
  /**
   * cacheWrite rate in the window's second half over its first half. Null when
   * the window cannot support the comparison — see `cacheWriteAcceleration`.
   */
  acceleration: number | null
  level: 'normal' | 'elevated' | 'runaway'
}

/** Trailing window. Long enough to smooth one slow turn, short enough to react. */
const WINDOW_MS = 90_000

/** Ignore windows shorter than this — two fast samples make any rate look huge. */
const MIN_SPAN_MS = 20_000

const ELEVATED_TPM = 400_000
const RUNAWAY_TPM = 1_000_000

/**
 * Above this ratio, cacheWrite is compounding rather than tapering.
 *
 * The gap it sits in is wide and was measured, not guessed: across both real
 * timelines in `burnRate.test.ts`, resampled at seven polling densities, no
 * window on the healthy session ever passed 0.91 while also clearing the rate
 * gate, and no window on the runaway one ever came in under 2.86. The
 * geometric middle of that gap is 1.61; 1.5 is the round number just below it,
 * biased slightly toward missing a slow loop over crying wolf on real work.
 */
const RUNAWAY_ACCELERATION = 1.5

/**
 * cacheWrite rate in the window's second half over its first half.
 *
 * The split is by *time*, not by sample index. Samples arrive from
 * `get_session_stats` polling on every completed sub-step, far more often than
 * model calls, so runs of consecutive samples carry identical counters. Those
 * duplicates move the midpoint's index but not its timestamp, which is what
 * keeps this stable as the polling rate changes.
 *
 * Returns null rather than a number whenever the window cannot support the
 * comparison: no sample strictly inside it to split on, or a first half that
 * wrote no cache at all (the ratio would be 0/0 or a division by zero). A
 * burst that begins mid-window lands in that last case; reporting nothing
 * costs at most one more poll, by which point both halves contain a call.
 */
function cacheWriteAcceleration(window: readonly BurnSample[]): number | null {
  const first = window[0]
  const last = window[window.length - 1]
  if (!first || !last) return null

  const midpoint = first.at + (last.at - first.at) / 2
  let split: BurnSample | undefined
  for (const sample of window) {
    if (sample.at > midpoint) break
    split = sample
  }
  if (!split || split.at <= first.at || split.at >= last.at) return null

  const firstRate = (split.cacheWrite - first.cacheWrite) / (split.at - first.at)
  const secondRate = (last.cacheWrite - split.cacheWrite) / (last.at - split.at)
  if (firstRate <= 0) return null

  return secondRate / firstRate
}

/**
 * Assess the trailing window. Returns null when there is not yet enough
 * history to say anything honest — callers should render nothing, not "normal".
 */
export function assessBurn(samples: readonly BurnSample[], now: number): BurnAssessment | null {
  const window = samples.filter((s) => now - s.at <= WINDOW_MS)
  const first = window[0]
  const last = window[window.length - 1]
  if (!first || !last || first === last) return null

  const spanMs = last.at - first.at
  if (spanMs < MIN_SPAN_MS) return null

  // Counters are cumulative and monotonic; a decrease means the session was
  // reset or compacted, so the window is not comparable.
  const billed = last.billed - first.billed
  const output = last.output - first.output
  const cacheWrite = last.cacheWrite - first.cacheWrite
  if (billed <= 0 || output < 0 || cacheWrite < 0) return null

  const tokensPerMinute = (billed / spanMs) * 60_000
  const tokenYield = output / billed
  const acceleration = cacheWriteAcceleration(window)
  const compounding = acceleration !== null && acceleration >= RUNAWAY_ACCELERATION

  let level: BurnAssessment['level'] = 'normal'
  if (compounding && tokensPerMinute >= RUNAWAY_TPM) {
    level = 'runaway'
  } else if (compounding && tokensPerMinute >= ELEVATED_TPM) {
    level = 'elevated'
  }

  return { tokensPerMinute, yield: tokenYield, acceleration, level }
}

/**
 * Per-session sample history. Samples arrive from `get_session_stats` polling,
 * which fires on every completed sub-step of a turn, so the buffer is trimmed
 * to the window on write rather than growing for the life of a session.
 */
const history = new Map<string, BurnSample[]>()

export function recordBurnSample(sessionId: string, sample: BurnSample): void {
  const kept = (history.get(sessionId) ?? []).filter((s) => sample.at - s.at <= WINDOW_MS)
  kept.push(sample)
  history.set(sessionId, kept)
}

export function burnSamples(sessionId: string): readonly BurnSample[] {
  return history.get(sessionId) ?? []
}

export function clearBurnSamples(sessionId: string): void {
  history.delete(sessionId)
}
