import { describe, it, expect, vi, afterEach } from 'vitest'
import { relativeTime, relativeTimeShort, absoluteTime } from './time'

/** Fixed "now" so the relative formatters are deterministic. */
const NOW = new Date('2026-08-03T12:00:00Z').getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function at(offsetMs: number): number {
  vi.setSystemTime(NOW)
  return NOW - offsetMs
}

afterEach(() => {
  vi.useRealTimers()
})

describe('relativeTime', () => {
  it.each([
    [0, 'just now'],
    [30_000, 'just now'],
    [MINUTE, '1 minute ago'],
    [2 * MINUTE, '2 minutes ago'],
    [59 * MINUTE, '59 minutes ago'],
    [HOUR, '1 hour ago'],
    [2 * HOUR, '2 hours ago'],
    [23 * HOUR, '23 hours ago'],
    [DAY, 'yesterday'],
    [2 * DAY, '2 days ago'],
    [6 * DAY, '6 days ago'],
  ])('formats %ims ago as %s', (offset, expected) => {
    vi.useFakeTimers()
    expect(relativeTime(at(offset))).toBe(expected)
  })

  it('falls back to a locale date at 7 days and beyond', () => {
    vi.useFakeTimers()
    const ms = at(7 * DAY)
    expect(relativeTime(ms)).toBe(new Date(ms).toLocaleDateString())
  })
})

describe('relativeTimeShort', () => {
  it.each([
    [0, 'now'],
    [30_000, 'now'],
    [MINUTE, '1m ago'],
    [59 * MINUTE, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR, '23h ago'],
    [DAY, '1d ago'],
    [6 * DAY, '6d ago'],
  ])('formats %ims ago as %s', (offset, expected) => {
    vi.useFakeTimers()
    expect(relativeTimeShort(at(offset))).toBe(expected)
  })

  it('falls back to a locale date at 7 days and beyond', () => {
    vi.useFakeTimers()
    const ms = at(7 * DAY)
    expect(relativeTimeShort(ms)).toBe(new Date(ms).toLocaleDateString())
  })

  it('never returns the long form', () => {
    vi.useFakeTimers()
    expect(relativeTimeShort(at(2 * MINUTE))).not.toContain('minutes')
  })
})

describe('absoluteTime', () => {
  it('delegates to toLocaleString', () => {
    expect(absoluteTime(NOW)).toBe(new Date(NOW).toLocaleString())
  })
})
