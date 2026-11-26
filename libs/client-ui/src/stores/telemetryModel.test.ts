import { describe, expect, it } from 'vitest'
import {
  EMPTY_POINTS,
  MAX_RATE_GAP_MS,
  RING_POINTS,
  EMPTY_VIEW,
  newView,
  ringWindow,
  withSample,
} from './telemetryModel'
import type { MachineTelemetry } from '@phosphor/shared/host-protocol-telemetry'

const T0 = 1_000_000

/** Two cores, half busy, 60 % of memory used, one pi process under the Host. */
function sample(over: Partial<MachineTelemetry> = {}): MachineTelemetry {
  return {
    at: T0,
    uptimeSec: 1_000,
    load: [2, 2, 2],
    cpu: {
      perCore: [
        { idle: 100, busy: 100 },
        { idle: 100, busy: 100 },
      ],
    },
    mem: { total: 1000, free: 200, used: 600, cache: 200, swapTotal: 100, swapUsed: 25 },
    disk: { total: 5000, free: 1000 },
    census: {
      kinds: [{ kind: 'pi', procs: 2, cpuSec: 10, rss: 400 }],
      procs: [],
    },
    ...over,
  }
}

/**
 * `steps` samples later — 2 s of wall clock each. Each core has run 20 jiffies
 * busy and 20 idle more, so the machine reads half busy whatever the counters'
 * absolute size, and the two pi processes together burned one cpu-second per
 * step: half a core.
 */
function later(steps: number, over: Partial<MachineTelemetry> = {}): MachineTelemetry {
  const moved = 20 * steps
  return sample({
    cpu: {
      perCore: [
        { idle: 100 + moved, busy: 100 + moved },
        { idle: 100 + moved, busy: 100 + moved },
      ],
    },
    census: {
      kinds: [{ kind: 'pi', procs: 2, cpuSec: 10 + steps, rss: 400 }],
      procs: [],
    },
    ...over,
  })
}

const fold = (view = newView(), telemetry = sample(), gap = false, receivedAt = T0) =>
  withSample(view, telemetry, gap, receivedAt)

describe('folding samples into a view', () => {
  it('shows no rate for the first sample, and real numbers for everything else', () => {
    const view = fold()
    expect(view.cpu).toBeNull()
    expect(view.corePct).toBeNull()
    expect(view.procPct).toEqual({})
    expect(view.phosphorPct).toBeNull()
    expect(view.memPct).toBe(60)
    expect(view.swapPct).toBe(25)
    expect(view.phosphorRss).toBe(400)
    expect(view.phosphorProcs).toBe(2)
    // Half of two cores busy is 50 % of one core, and load is per core.
    expect(view.load1Pct).toBe(1)
    expect(view.current).not.toBeNull()
  })

  it('reads a rate from two consecutive samples', () => {
    const view = fold(fold(), later(1), false, T0 + 2_000)
    expect(view.cpu).toBeCloseTo(50, 6)
    expect(view.corePct).toEqual([50, 50])
    // Two pi processes burned 1 cpu-second of the 2 s, half a core each.
    expect(view.procPct.pi).toBeCloseTo(50, 6)
    expect(view.phosphorPct).toBeCloseTo(50, 6)
    expect(view.points.length).toBe(2)
  })

  it('withholds every rate across a gap, but keeps the sample it can show', () => {
    const view = fold(fold(), later(1), true, T0 + 2_000)
    expect(view.cpu).toBeNull()
    expect(view.corePct).toBeNull()
    expect(view.procPct).toEqual({})
    expect(view.phosphorPct).toBeNull()
    expect(view.memPct).toBe(60)
    expect(view.points.length).toBe(2)
  })

  it('withholds them across a poll that stalled on its own', () => {
    const view = fold(fold(), later(1), false, T0 + MAX_RATE_GAP_MS + 1)
    expect(view.cpu).toBeNull()
    expect(view.procPct).toEqual({})
  })

  it('ages on this clock, so a Host minutes behind still reads true', () => {
    const first = fold(newView(), sample({ at: T0 + 600_000 }), false, T0)
    const view = fold(first, later(1, { at: T0 + 600_002_000 }), false, T0 + 2_000)
    expect(view.cpu).toBeCloseTo(50, 6)
    expect(view.receivedAt).toBe(T0 + 2_000)
  })

  it('reads a census that failed as zero, not as unknown', () => {
    const view = fold(newView(), sample({ census: null }))
    expect(view.phosphorRss).toBe(0)
    expect(view.phosphorProcs).toBe(0)
    // And a rate needs two censuses, not a sample that has since lost one.
    const next = fold(view, later(1), false, T0 + 2_000)
    expect(next.procPct).toEqual({})
    expect(next.phosphorPct).toBeNull()
  })

  it('sizes the core row to the sample on screen', () => {
    const one = fold(newView(), sample({ cpu: { perCore: [{ idle: 100, busy: 100 }] } }))
    const grown = fold(
      one,
      later(1, {
        cpu: {
          perCore: [
            { idle: 120, busy: 120 },
            { idle: 0, busy: 0 },
          ],
        },
      }),
      false,
      T0 + 2_000,
    )
    expect(grown.corePct?.length).toBe(2)
    expect(grown.corePct?.[0]).toBeCloseTo(50, 6)
    // A core with no predecessor has no rate, and must not read as NaN.
    expect(grown.corePct?.[1]).toBe(0)
    expect(grown.load1Pct).toBe(1)
  })

  it('keeps the ring bounded, oldest out first', () => {
    let view = newView()
    for (let step = 0; step < RING_POINTS + 250; step++)
      view = fold(view, later(1), false, T0 + step * 2_000)
    expect(view.points.length).toBe(RING_POINTS)
    expect(view.points[0]?.receivedAt).toBe(T0 + 250 * 2_000)
    expect(view.points.at(-1)?.receivedAt).toBe(T0 + (RING_POINTS + 249) * 2_000)
  })

  it('holds Phosphor share between samples that cannot measure it', () => {
    const first = fold()
    expect(first.points[0]?.phosphorPct).toBe(0)
    const second = fold(first, later(1), false, T0 + 2_000)
    expect(second.points[1]?.phosphorPct).toBeCloseTo(50, 6)
    const gapped = fold(second, later(2), true, T0 + 6_000)
    expect(gapped.points.at(-1)?.phosphorPct).toBeCloseTo(50, 6)
  })
})

describe('the history ring', () => {
  const ring = [1, 2, 3, 4].map((minute) => ({
    receivedAt: T0 + minute * 60_000,
    cpu: minute,
    memPct: 10,
    phosphorPct: 1,
  }))

  it('takes the tail a range control asks for', () => {
    expect(ringWindow(ring, 60_000, T0 + 4 * 60_000).map((p) => p.cpu)).toEqual([4])
    expect(ringWindow(ring, 180_000, T0 + 4 * 60_000).map((p) => p.cpu)).toEqual([2, 3, 4])
    expect(ringWindow(ring, 3_600_000, T0 + 4 * 60_000).length).toBe(4)
  })

  it('answers with the shared empty ring when there is nothing to show', () => {
    expect(ringWindow([], 60_000, T0)).toBe(EMPTY_POINTS)
    expect(ringWindow(ring, 60_000, T0 + 600_000)).toBe(EMPTY_POINTS)
    expect(EMPTY_VIEW.points).toBe(EMPTY_POINTS)
  })
})
