import { describe, it, expect, beforeEach } from 'vitest'
import {
  assessBurn,
  recordBurnSample,
  burnSamples,
  clearBurnSamples,
  type BurnSample,
} from './burnRate'

const T0 = 1_700_000_000_000

/**
 * A three-point window: one sample at each end and one at the midpoint, so the
 * halves the detector compares are explicit. Acceleration works out to exactly
 * `cwSecondHalf / cwFirstHalf`, because both halves span the same time.
 */
function ramp(
  spanMs: number,
  billed: number,
  output: number,
  cwFirstHalf: number,
  cwSecondHalf: number,
): BurnSample[] {
  return [
    { at: T0, billed: 1_000, output: 100, cacheWrite: 10_000 },
    {
      at: T0 + spanMs / 2,
      billed: 1_000 + billed / 2,
      output: 100 + output / 2,
      cacheWrite: 10_000 + cwFirstHalf,
    },
    {
      at: T0 + spanMs,
      billed: 1_000 + billed,
      output: 100 + output,
      cacheWrite: 10_000 + cwFirstHalf + cwSecondHalf,
    },
  ]
}

/**
 * Real measurements, not invented numbers. Each entry is one completed model
 * call: milliseconds since the session's first call, then the cumulative
 * billed / output / cacheWrite counters as `get_session_stats` would report
 * them at that instant. Extracted from `.message.usage` in pi's own transcripts.
 *
 * Session 01a02c8e — "read each of the 12 largest .tsx files". Completely
 * healthy: 13 calls, 12 files read, exactly what was asked. Final yield 0.93%,
 * which is *lower* than the 1.15% of a mixed session and barely above the
 * 0.50% of the genuine runaway below. This is the false positive being fixed:
 * the yield-gated detector called this session "elevated" from t+65s onward.
 */
const HEALTHY: readonly BurnSample[] = [
  { at: T0 + 0, billed: 32_283, output: 713, cacheWrite: 12_406 },
  { at: T0 + 6_650, billed: 65_362, output: 1_147, cacheWrite: 25_893 },
  { at: T0 + 15_729, billed: 108_143, output: 1_713, cacheWrite: 36_548 },
  { at: T0 + 23_927, billed: 156_337, output: 2_242, cacheWrite: 51_554 },
  { at: T0 + 30_469, billed: 209_728, output: 2_626, cacheWrite: 62_332 },
  { at: T0 + 38_387, billed: 268_371, output: 3_118, cacheWrite: 72_804 },
  { at: T0 + 46_021, billed: 331_552, output: 3_525, cacheWrite: 82_557 },
  { at: T0 + 55_717, billed: 399_398, output: 4_211, cacheWrite: 91_552 },
  { at: T0 + 65_184, billed: 471_328, output: 4_800, cacheWrite: 100_105 },
  { at: T0 + 75_753, billed: 547_099, output: 5_582, cacheWrite: 107_920 },
  { at: T0 + 82_933, billed: 626_289, output: 5_971, cacheWrite: 115_366 },
  { at: T0 + 90_919, billed: 708_883, output: 6_518, cacheWrite: 122_410 },
  { at: T0 + 101_814, billed: 798_319, output: 7_389, cacheWrite: 132_160 },
]

/**
 * Session 01a02bb0 — a genuine runaway: the provider's resume prompt grew 51x
 * as it replayed the transcript it had already sent. Final yield 0.50%.
 * cacheWrite per call climbs from ~5k to ~76k as the replayed prefix grows,
 * which is the compounding this detector is built to see.
 */
const RUNAWAY: readonly BurnSample[] = [
  { at: T0 + 0, billed: 27_733, output: 298, cacheWrite: 27_433 },
  { at: T0 + 5_506, billed: 58_980, output: 526, cacheWrite: 40_975 },
  { at: T0 + 13_188, billed: 92_739, output: 990, cacheWrite: 46_433 },
  { at: T0 + 29_879, billed: 152_935, output: 1_827, cacheWrite: 74_756 },
  { at: T0 + 41_099, billed: 245_577, output: 2_491, cacheWrite: 133_422 },
  { at: T0 + 50_364, billed: 371_589, output: 3_019, cacheWrite: 199_530 },
  { at: T0 + 62_064, billed: 533_964, output: 3_699, cacheWrite: 269_230 },
  { at: T0 + 69_244, billed: 735_688, output: 3_702, cacheWrite: 345_450 },
]

/** Every verdict the detector would render as the timeline plays out. */
function verdicts(samples: readonly BurnSample[]): (string | null)[] {
  const out: (string | null)[] = []
  for (let n = 2; n <= samples.length; n++) {
    const prefix = samples.slice(0, n)
    const last = prefix[prefix.length - 1]
    if (!last) continue
    out.push(assessBurn(prefix, last.at)?.level ?? null)
  }
  return out
}

/**
 * What polling actually delivers. `get_session_stats` fires on every completed
 * sub-step, not once per model call, so between two real calls there are runs
 * of samples carrying identical counters and zero deltas.
 */
function withPolling(samples: readonly BurnSample[], perGap: number): BurnSample[] {
  const out: BurnSample[] = []
  samples.forEach((sample, i) => {
    out.push(sample)
    const next = samples[i + 1]
    if (!next) return
    const step = (next.at - sample.at) / (perGap + 1)
    for (let k = 1; k <= perGap; k++) {
      out.push({ ...sample, at: Math.round(sample.at + step * k) })
    }
  })
  return out
}

describe('assessBurn', () => {
  it('returns null until there are two samples', () => {
    expect(assessBurn([], T0)).toBeNull()
    expect(assessBurn([{ at: T0, billed: 100, output: 10, cacheWrite: 50 }], T0)).toBeNull()
  })

  it('returns null when the window is too short to be meaningful', () => {
    // Two samples 3s apart would imply a huge rate from a tiny sample.
    expect(assessBurn(ramp(3_000, 500_000, 0, 1_000, 200_000), T0 + 3_000)).toBeNull()
  })

  it('ignores samples that have aged out of the window', () => {
    const stale: BurnSample[] = [
      { at: T0 - 600_000, billed: 0, output: 0, cacheWrite: 0 },
      { at: T0, billed: 5_000_000, output: 100, cacheWrite: 4_000_000 },
    ]
    // Only the recent sample survives the filter, so there is nothing to compare.
    expect(assessBurn(stale, T0)).toBeNull()
  })

  it('returns null when counters go backwards (session reset or compaction)', () => {
    const billedBack: BurnSample[] = [
      { at: T0, billed: 900_000, output: 5_000, cacheWrite: 400_000 },
      { at: T0 + 60_000, billed: 40_000, output: 200, cacheWrite: 20_000 },
    ]
    expect(assessBurn(billedBack, T0 + 60_000)).toBeNull()

    const cacheBack: BurnSample[] = [
      { at: T0, billed: 900_000, output: 5_000, cacheWrite: 400_000 },
      { at: T0 + 60_000, billed: 1_900_000, output: 5_200, cacheWrite: 20_000 },
    ]
    expect(assessBurn(cacheBack, T0 + 60_000)).toBeNull()
  })

  it('reports normal for a healthy working session', () => {
    const a = assessBurn(ramp(60_000, 120_000, 5_000, 30_000, 20_000), T0 + 60_000)
    expect(a?.level).toBe('normal')
    expect(Math.round(a!.tokensPerMinute)).toBe(120_000)
  })

  it('reports normal at a high rate while cacheWrite is tapering', () => {
    // 1.5M/min, but the prefix stays cached so cacheWrite shrinks: a
    // big-context session doing genuine work must not be flagged for its size.
    const a = assessBurn(ramp(60_000, 1_500_000, 90_000, 300_000, 200_000), T0 + 60_000)
    expect(a?.acceleration).toBeCloseTo(0.667, 2)
    expect(a?.level).toBe('normal')
  })

  it('reports elevated at a moderate rate with cacheWrite accelerating', () => {
    const a = assessBurn(ramp(60_000, 500_000, 1_000, 50_000, 150_000), T0 + 60_000)
    expect(a?.acceleration).toBeCloseTo(3, 5)
    expect(a?.level).toBe('elevated')
  })

  it('reports runaway at the rate the 2026-08-21 incident actually ran', () => {
    const a = assessBurn(ramp(60_000, 3_500_000, 7_000, 400_000, 1_600_000), T0 + 60_000)
    expect(a?.level).toBe('runaway')
    expect(a!.yield).toBeLessThan(0.01)
  })

  it('still respects the rate gate when cacheWrite accelerates slowly', () => {
    // 200k/min is ordinary. Acceleration alone must not raise a warning.
    const a = assessBurn(ramp(60_000, 200_000, 2_000, 20_000, 100_000), T0 + 60_000)
    expect(a?.acceleration).toBeCloseTo(5, 5)
    expect(a?.level).toBe('normal')
  })

  it('does not let a healthy yield suppress a real runaway', () => {
    // 6% output — the yield-gated detector would have called this normal.
    const a = assessBurn(ramp(60_000, 1_500_000, 90_000, 100_000, 400_000), T0 + 60_000)
    expect(a!.yield).toBeGreaterThan(0.05)
    expect(a?.level).toBe('runaway')
  })
})

describe('real session timelines', () => {
  it('never warns at any point in the healthy session (01a02c8e)', () => {
    expect(verdicts(HEALTHY)).not.toContain('elevated')
    expect(verdicts(HEALTHY)).not.toContain('runaway')
  })

  it('is the regression: the healthy session clears the rate gate with a runaway-looking yield', () => {
    // t+65s is where the yield-gated detector started saying "elevated".
    const at65s = HEALTHY.slice(0, 9)
    const a = assessBurn(at65s, T0 + 65_184)
    expect(a).not.toBeNull()
    expect(a!.tokensPerMinute).toBeGreaterThan(400_000)
    expect(a!.yield).toBeLessThan(0.02)
    // Both of the old signals fire; cacheWrite is tapering, so this one does not.
    expect(a!.acceleration).toBeLessThan(1)
    expect(a!.level).toBe('normal')
  })

  it('warns on the runaway session (01a02bb0)', () => {
    expect(verdicts(RUNAWAY)).toContain('elevated')
    const a = assessBurn(RUNAWAY, T0 + 69_244)
    expect(a!.level).toBe('elevated')
    expect(a!.acceleration).toBeGreaterThan(4)
  })

  it('separates the two by acceleration, not by yield', () => {
    const healthy = assessBurn(HEALTHY, T0 + 101_814)!
    const runaway = assessBurn(RUNAWAY, T0 + 69_244)!
    // Yield puts the healthy session between the bad ones — useless as a gate.
    expect(healthy.yield).toBeGreaterThan(runaway.yield)
    expect(healthy.yield).toBeLessThan(0.02)
    // Acceleration puts a wide gap between them.
    expect(healthy.acceleration).toBeLessThan(1)
    expect(runaway.acceleration).toBeGreaterThan(4)
  })
})

describe('polling robustness', () => {
  // Duplicate, zero-delta samples between model calls must not change a verdict.
  for (const perGap of [1, 2, 5, 12]) {
    it(`holds the healthy verdict with ${perGap} duplicate sample(s) per gap`, () => {
      const levels = verdicts(withPolling(HEALTHY, perGap))
      expect(levels).not.toContain('elevated')
      expect(levels).not.toContain('runaway')
    })

    it(`holds the runaway verdict with ${perGap} duplicate sample(s) per gap`, () => {
      expect(verdicts(withPolling(RUNAWAY, perGap))).toContain('elevated')
    })
  }

  it('survives a half with no cacheWrite movement at all', () => {
    // Nothing completes for the first half of the window, then a burst. The
    // naive first-half rate is 0, which would divide to Infinity or NaN.
    const idleThenBurst: BurnSample[] = [
      { at: T0, billed: 1_000_000, output: 20_000, cacheWrite: 500_000 },
      { at: T0 + 20_000, billed: 1_000_000, output: 20_000, cacheWrite: 500_000 },
      { at: T0 + 40_000, billed: 1_000_000, output: 20_000, cacheWrite: 500_000 },
      { at: T0 + 60_000, billed: 1_900_000, output: 20_400, cacheWrite: 1_100_000 },
    ]
    const a = assessBurn(idleThenBurst, T0 + 60_000)
    expect(a).not.toBeNull()
    expect(a!.acceleration).toBeNull()
    expect(a!.level).toBe('normal')
    expect(Number.isFinite(a!.tokensPerMinute)).toBe(true)
  })

  it('returns null for a window of nothing but duplicate samples', () => {
    const idle: BurnSample[] = [
      { at: T0, billed: 500_000, output: 9_000, cacheWrite: 100_000 },
      { at: T0 + 30_000, billed: 500_000, output: 9_000, cacheWrite: 100_000 },
      { at: T0 + 60_000, billed: 500_000, output: 9_000, cacheWrite: 100_000 },
    ]
    expect(assessBurn(idle, T0 + 60_000)).toBeNull()
  })
})

describe('sample history', () => {
  beforeEach(() => clearBurnSamples('s1'))

  it('keeps samples per session and trims to the window', () => {
    recordBurnSample('s1', { at: T0, billed: 10, output: 1, cacheWrite: 5 })
    recordBurnSample('s1', { at: T0 + 30_000, billed: 20, output: 2, cacheWrite: 9 })
    expect(burnSamples('s1')).toHaveLength(2)

    // A sample well past the window drops everything older than it.
    recordBurnSample('s1', { at: T0 + 500_000, billed: 30, output: 3, cacheWrite: 12 })
    expect(burnSamples('s1')).toHaveLength(1)
  })

  it('does not leak between sessions', () => {
    recordBurnSample('s1', { at: T0, billed: 10, output: 1, cacheWrite: 5 })
    expect(burnSamples('s2')).toHaveLength(0)
    clearBurnSamples('s2')
    expect(burnSamples('s1')).toHaveLength(1)
  })
})
