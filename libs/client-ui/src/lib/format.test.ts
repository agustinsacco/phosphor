import { describe, it, expect } from 'vitest'
import { formatTokens, formatDuration, formatBytes } from './format'

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [999, '999'],
  ])('renders %i exactly below 1k', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })

  it.each([
    [1000, '1.0k'],
    [1500, '1.5k'],
    [12_345, '12.3k'],
    [99_999, '100.0k'],
  ])('keeps one decimal in the k tier below 100k (%i → %s)', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })

  it.each([
    [100_000, '100k'],
    [250_400, '250k'],
    [999_999, '1000k'],
  ])('drops the decimal at and above 100k (%i → %s)', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })

  it.each([
    [1_000_000, '1.0M'],
    [1_500_000, '1.5M'],
    [12_000_000, '12.0M'],
  ])('uses the M tier at and above 1M (%i → %s)', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })

  it('never renders a million-scale count in the k tier', () => {
    // Regression: one of the three pre-consolidation copies lacked the M tier
    // and rendered a 1.5M-token compaction as "1500000.0k".
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [1, '1ms'],
    [999, '999ms'],
  ])('renders %ims in milliseconds', (input, expected) => {
    expect(formatDuration(input)).toBe(expected)
  })

  it.each([
    [1000, '1.0s'],
    [1440, '1.4s'],
    [59_900, '59.9s'],
  ])('renders %ims in seconds with one decimal', (input, expected) => {
    expect(formatDuration(input)).toBe(expected)
  })

  it.each([
    [60_000, '1m 0s'],
    [125_000, '2m 5s'],
    [3_600_000, '60m 0s'],
  ])('renders %ims as minutes and seconds', (input, expected) => {
    expect(formatDuration(input)).toBe(expected)
  })

  it('rounds the seconds remainder rather than truncating', () => {
    expect(formatDuration(61_600)).toBe('1m 2s')
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
  ])('renders %i as exact bytes below 1 KiB', (input, expected) => {
    expect(formatBytes(input)).toBe(expected)
  })

  it.each([
    [1024, '1.0 KB'],
    [12_700, '12.4 KB'],
    [1_048_575, '1024.0 KB'],
  ])('renders %i in the KB tier with one decimal', (input, expected) => {
    expect(formatBytes(input)).toBe(expected)
  })

  it.each([
    [1_048_576, '1.0 MB'],
    [13_800_000, '13.2 MB'],
  ])('renders %i in the MB tier', (input, expected) => {
    expect(formatBytes(input)).toBe(expected)
  })

  // A video in the Files pane, not a tool payload.
  it.each([
    [1024 ** 3, '1.0 GB'],
    [2_500_000_000, '2.3 GB'],
  ])('renders %i in the GB tier', (input, expected) => {
    expect(formatBytes(input)).toBe(expected)
  })

  /*
   * This drives the streaming label on a tool card whose args are still
   * arriving, so it is called on every delta: it must never widen mid-stream in
   * a way that reflows the row (one decimal, single unit switch per tier).
   */
  it('renders streaming size samples across the tiers', () => {
    const sizes = [0, 512, 1024, 20_000, 500_000, 2_000_000]
    const rendered = sizes.map(formatBytes)
    expect(rendered).toEqual(['0 B', '512 B', '1.0 KB', '19.5 KB', '488.3 KB', '1.9 MB'])
  })

  it('never widens past a fixed budget while a payload streams (no row reflow)', () => {
    // The real property the streaming hint depends on: rendered width stays
    // bounded, so a label repainted on every delta can't reflow its row.
    for (let n = 0; n <= 4_000_000; n += 4093) {
      expect(formatBytes(n).length).toBeLessThanOrEqual(9)
    }
  })
})
