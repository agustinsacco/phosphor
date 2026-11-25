import { describe, expect, it } from 'vitest'
import {
  GEN_WINDOW_MS,
  genRateFrom,
  recordGenSample,
  resetGenSamples,
  type GenSample,
} from './genRate'

const T0 = 1_000_000

/** Steady stream: `rate` output tokens a second, for `seconds`, from `start`. */
function streaming(rate: number, seconds: number, start = T0, from = 0): GenSample[] {
  return Array.from({ length: seconds + 1 }, (_, i) => ({
    t: start + i * 1000,
    tokens: from + Math.round(rate * i),
  }))
}

describe('recordGenSample', () => {
  it('keeps readings in order and drops a poll that moved the total backwards', () => {
    const samples: GenSample[] = []
    recordGenSample(samples, T0, 100)
    recordGenSample(samples, T0 + 1000, 120)
    // A `get_session_stats` re-seed can land under the live overlay's figure.
    recordGenSample(samples, T0 + 2000, 90)
    expect(samples.map((s) => s.tokens)).toEqual([100, 120])
  })

  it('replaces a reading at the same instant instead of stacking two', () => {
    const samples: GenSample[] = []
    recordGenSample(samples, T0, 100)
    recordGenSample(samples, T0, 140)
    expect(samples).toEqual([{ t: T0, tokens: 140 }])
  })

  it('drops what fell out of the retention window but keeps one prior reading', () => {
    const samples: GenSample[] = []
    for (let i = 0; i < 200; i++) recordGenSample(samples, T0 + i * 1000, i * 10)
    // One reading behind the window is what lets the next one still have a span.
    const stale = samples.filter((s) => s.t < T0 + 200_000 - 60_000)
    expect(stale.length).toBeLessThanOrEqual(1)
    expect(samples.length).toBeLessThan(70)
  })
})

describe('genRateFrom', () => {
  it('reports the tokens per second a steady stream is giving', () => {
    const samples = streaming(60, 5)
    const rate = genRateFrom(samples, samples.at(-1)!.t)
    expect(rate).not.toBeNull()
    expect(rate!.tokensPerSecond).toBeCloseTo(60, 0)
    expect(rate!.tokens).toBeGreaterThan(0)
  })

  it('says nothing before two seconds of stream, which is not a rate', () => {
    expect(genRateFrom(streaming(60, 1), T0 + 1000)).toBeNull()
    expect(genRateFrom([{ t: T0, tokens: 0 }], T0)).toBeNull()
  })

  it('says nothing while the model is not generating', () => {
    // 40 tokens, then a 30-second tool call with the tick still sampling.
    const samples = [
      { t: T0, tokens: 100 },
      { t: T0 + 1000, tokens: 120 },
      { t: T0 + 2000, tokens: 140 },
      ...Array.from({ length: 28 }, (_, i) => ({ t: T0 + 3000 + i * 1000, tokens: 140 })),
    ]
    expect(genRateFrom(samples, samples.at(-1)!.t)).toBeNull()
  })

  it('resumes once tokens flow again, ignoring the dead time before the stream', () => {
    const generation = Array.from({ length: 8 }, (_, i) => ({
      t: T0 + 32_000 + i * 1000,
      tokens: 140 + (i + 1) * 20,
    }))
    const samples = [
      { t: T0, tokens: 100 },
      { t: T0 + 1000, tokens: 120 },
      { t: T0 + 2000, tokens: 140 },
      ...Array.from({ length: 28 }, (_, i) => ({ t: T0 + 3000 + i * 1000, tokens: 140 })),
      ...generation,
    ]
    const rate = genRateFrom(samples, generation.at(-1)!.t)
    // Averaged over the whole 39-second run this would read ~2 tok/s, which is
    // the wait, not the model. Only the trailing window is measured.
    expect(rate!.tokensPerSecond).toBeGreaterThan(12)
    expect(rate!.spanMs).toBeLessThanOrEqual(GEN_WINDOW_MS)
  })

  it('caps the measured stretch at the window so a speed change catches up', () => {
    const samples = streaming(10, 40)
    const rate = genRateFrom(samples, samples.at(-1)!.t)
    expect(rate!.spanMs).toBeLessThanOrEqual(GEN_WINDOW_MS)
    expect(rate!.tokensPerSecond).toBeCloseTo(10, 0)
  })

  it('ignores an old total: a reading nobody refreshed is not a stream', () => {
    const samples = streaming(60, 5)
    expect(genRateFrom(samples, samples.at(-1)!.t + 120_000)).toBeNull()
  })

  it('survives a run that spent nothing yet (usage has not arrived)', () => {
    const samples = streaming(0, 8)
    expect(genRateFrom(samples, samples.at(-1)!.t)).toBeNull()
  })
})

describe('resetGenSamples', () => {
  it('starts a new run from nothing', () => {
    const samples = streaming(60, 5)
    resetGenSamples(samples)
    expect(samples).toEqual([])
    expect(genRateFrom(samples, T0)).toBeNull()
  })
})
