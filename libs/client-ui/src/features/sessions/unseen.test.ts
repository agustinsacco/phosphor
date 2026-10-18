import { describe, expect, it } from 'vitest'
import { isUnseen } from './unseen'

const T0 = Date.parse('2026-08-09T12:00:00.000Z')

describe('isUnseen', () => {
  it('is seen when there is no marker (upgrade path)', () => {
    expect(isUnseen({}, '/s.jsonl', '2026-08-09T13:00:00.000Z')).toBe(false)
  })

  it('is unseen when activity is newer than the marker', () => {
    expect(isUnseen({ '/s.jsonl': T0 }, '/s.jsonl', '2026-08-09T12:01:00.000Z')).toBe(true)
  })

  it('is seen when activity predates the marker', () => {
    expect(isUnseen({ '/s.jsonl': T0 }, '/s.jsonl', '2026-08-09T11:00:00.000Z')).toBe(false)
  })

  it('absorbs trailing writes within the slop window', () => {
    expect(isUnseen({ '/s.jsonl': T0 }, '/s.jsonl', new Date(T0 + 1500).toISOString())).toBe(false)
    expect(isUnseen({ '/s.jsonl': T0 }, '/s.jsonl', new Date(T0 + 2500).toISOString())).toBe(true)
  })

  it('is seen for missing or invalid activity timestamps', () => {
    expect(isUnseen({ '/s.jsonl': T0 }, '/s.jsonl', undefined)).toBe(false)
    expect(isUnseen({ '/s.jsonl': T0 }, '/s.jsonl', 'not-a-date')).toBe(false)
  })
})
