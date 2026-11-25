import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  relativeTime,
  relativeTimeShort,
  absoluteTime,
  clockTime,
  isSameLocalDay,
  dayLabel,
} from './time'

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

describe('clockTime', () => {
  it("shows the hour and minutes in the reader's own format", () => {
    expect(clockTime(NOW)).toBe(
      new Date(NOW).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    )
  })

  it('never carries the seconds or the date a tooltip already gives', () => {
    expect(clockTime(NOW).split(':')).toHaveLength(2)
    expect(clockTime(NOW)).not.toMatch(/\d{4}/)
  })
})

describe('isSameLocalDay', () => {
  it('holds across a day of minutes', () => {
    expect(isSameLocalDay(NOW, NOW + 6 * HOUR)).toBe(true)
  })

  it('breaks at local midnight, not at 24 hours', () => {
    const justBeforeMidnight = new Date('2026-08-03T23:59:00').getTime()
    const justAfter = new Date('2026-08-04T00:01:00').getTime()
    expect(isSameLocalDay(justBeforeMidnight, justAfter)).toBe(false)
    // Nearly 24 hours apart and the SAME calendar day: no boundary, no divider.
    expect(
      isSameLocalDay(
        new Date('2026-08-04T00:05:00').getTime(),
        new Date('2026-08-04T23:55:00').getTime(),
      ),
    ).toBe(true)
  })
})

describe('dayLabel', () => {
  it('names today and yesterday relatively', () => {
    expect(dayLabel(NOW, NOW)).toBe('Today')
    expect(dayLabel(NOW - 3 * HOUR, NOW)).toBe('Today')
    expect(dayLabel(NOW - 25 * HOUR, NOW)).toBe('Yesterday')
  })

  it('dates anything older with the weekday', () => {
    const threeDaysAgo = NOW - 3 * DAY
    expect(dayLabel(threeDaysAgo, NOW)).toBe(
      new Date(threeDaysAgo).toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    )
  })

  it('adds the year across one, so last March cannot read as this March', () => {
    const lastYear = new Date('2025-03-03T12:00:00').getTime()
    expect(dayLabel(lastYear, NOW)).toBe(
      new Date(lastYear).toLocaleDateString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    )
    expect(dayLabel(lastYear, NOW)).toContain('2025')
  })
})
