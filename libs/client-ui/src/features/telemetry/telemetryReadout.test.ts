import { describe, expect, it } from 'vitest'
import {
  RANGES,
  brailleBars,
  formatBytesOr,
  formatPct,
  rangeMs,
  sampledAgo,
} from './telemetryReadout'

describe('ranges', () => {
  it('offers an hour of the ring, and nothing the ring cannot cover', () => {
    expect(RANGES.map((r) => r.label)).toEqual(['1m', '5m', '1h'])
    expect(rangeMs('1h')).toBe(3_600_000)
    // RING_POINTS at the 2 s poll is exactly the widest window offered.
    expect(rangeMs('1h') / 2_000).toBe(1_800)
  })
})

describe('numbers a machine refused', () => {
  it('says the same word for every unreadable value', () => {
    expect(formatPct(null)).toBe('—')
    expect(formatPct(undefined)).toBe('—')
    expect(formatPct(Number.NaN)).toBe('—')
    expect(formatBytesOr(null)).toBe('—')
  })

  it('reads a percentage and a size the way the popover columns need', () => {
    expect(formatPct(48.4)).toBe('48%')
    expect(formatPct(48.4, 1)).toBe('48.4%')
    expect(formatPct(0)).toBe('0%')
    expect(formatBytesOr(2 * 1024 ** 3)).toBe('2.0 GB')
    expect(formatBytesOr(512 * 1024 ** 2)).toBe('512.0 MB')
  })
})

describe('the age of the sample on screen', () => {
  const STALE = 6_000
  it('stops calling an age an age once the poll has stalled', () => {
    expect(sampledAgo(null, STALE)).toBe('no sample yet')
    expect(sampledAgo(900, STALE)).toBe('just now')
    expect(sampledAgo(4_200, STALE)).toBe('4s ago')
    // A remembered sample, on a screen that stopped watching: the caller sets a
    // bound wide enough that an age can still be read as an age.
    expect(sampledAgo(125_000, 5 * 60_000)).toBe('2m ago')
    expect(sampledAgo(6_000, STALE)).toBe('sample stalled')
    expect(sampledAgo(9_000_000, STALE)).toBe('sample stalled')
  })
})

const cell = (bits: number): string => String.fromCharCode(0x2800 + bits)

describe('brailleBars', () => {
  it('draws nothing for nothing', () => {
    expect(brailleBars([], 40)).toBe('')
    expect(brailleBars([50], 0)).toBe('')
  })

  it('packs two samples into every character', () => {
    // Two samples at 0%: an empty cell, not a blank space.
    expect(brailleBars([0, 0], 1)).toBe('⠀')
    // Left half of the cell is the older sample, right half the newer one.
    expect(brailleBars([100, 0], 1)).toBe(cell(LEFT_FULL))
    expect(brailleBars([0, 100], 1)).toBe(cell(RIGHT_FULL))
    expect(brailleBars([100, 100], 1)).toBe(cell(LEFT_FULL | RIGHT_FULL))
    expect(brailleBars([1, 2, 3, 4], 2)).toHaveLength(2)
  })

  it('draws a lone sample in both halves of its cell', () => {
    // A window wider than the ring so far: the one sample it has cannot be in
    // one half of a cell and not the other, so it stands in both.
    expect(brailleBars([25], 1)).toBe(cell(0x20 | 0x80))
  })

  it('keeps the spike a bucket contains', () => {
    // A window far wider than the sample count: the 90% between two quiet
    // samples must still show, or the graph promises a calm machine that lied.
    const quiet = new Array<number>(40).fill(0)
    quiet[20] = 90
    const flat = brailleBars(quiet, 20)
    const spikes = [...flat].filter((c) => c !== '⠀').length
    expect(spikes).toBeGreaterThan(0)
    expect(brailleBars(new Array<number>(40).fill(0), 20)).toBe('⠀'.repeat(20))
  })

  it('fills a column from the bottom up', () => {
    // 50% is the two bottom dots; 100% is the full column of four.
    expect(brailleBars([50, 0], 1)).toBe(cell(0x20 | 0x04))
    expect(brailleBars([100, 0], 1)).toBe(cell(LEFT_FULL))
  })

  const LEFT_FULL = 0x20 | 0x04 | 0x02 | 0x01
  const RIGHT_FULL = 0x80 | 0x40 | 0x10 | 0x08
})
