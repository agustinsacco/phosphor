import { describe, expect, it } from 'vitest'
import type { SessionMeta } from './models'
import { compareSessionsByCreation } from './session-order'

type SessionTime = Pick<SessionMeta, 'createdAt' | 'mtimeMs'>

describe('compareSessionsByCreation', () => {
  it('sorts newest immutable creation time first, not most recently changed mtime', () => {
    const older: SessionTime = { createdAt: '2025-01-01T00:00:00Z', mtimeMs: 9e12 }
    const newer: SessionTime = { createdAt: '2025-01-02T00:00:00Z', mtimeMs: 0 }

    expect(compareSessionsByCreation(newer, older)).toBe(-86_400_000)
    expect(compareSessionsByCreation(older, newer)).toBe(86_400_000)
    expect([older, newer].sort(compareSessionsByCreation)).toEqual([newer, older])
    expect(compareSessionsByCreation({ ...older, mtimeMs: 1e13 }, newer)).toBe(86_400_000)
  })

  it.each(['', 'not-a-date', '2025-99-99T00:00:00Z'])(
    'falls back to mtime for invalid creation time %j on either side',
    (createdAt) => {
      const invalid: SessionTime = { createdAt, mtimeMs: 2_000 }
      const valid: SessionTime = { createdAt: '1970-01-01T00:00:01Z', mtimeMs: 9_000 }
      expect(compareSessionsByCreation(invalid, valid)).toBe(-1_000)
      expect(compareSessionsByCreation(valid, invalid)).toBe(1_000)
    },
  )

  it('orders two invalid creation times by newest mtime', () => {
    const older = { createdAt: '', mtimeMs: 1_000 }
    const newer = { createdAt: 'invalid', mtimeMs: 2_000 }
    expect(compareSessionsByCreation(newer, older)).toBe(-1_000)
    expect(compareSessionsByCreation(older, newer)).toBe(1_000)
  })

  it('uses finite epoch and pre-epoch creation times instead of falling back', () => {
    const beforeEpoch = { createdAt: '1969-12-31T23:59:59Z', mtimeMs: 9_000 }
    const epoch = { createdAt: '1970-01-01T00:00:00Z', mtimeMs: 8_000 }
    const fallback = { createdAt: '', mtimeMs: 1_000 }
    expect([beforeEpoch, epoch, fallback].sort(compareSessionsByCreation)).toEqual([
      fallback,
      epoch,
      beforeEpoch,
    ])
  })

  it('returns zero for equal creation instants despite different text and mtimes', () => {
    const first = { createdAt: '2025-01-01T00:00:00Z', mtimeMs: 2_000 }
    const second = { createdAt: '2024-12-31T19:00:00-05:00', mtimeMs: 1_000 }
    expect(compareSessionsByCreation(first, second)).toBe(0)
    expect(compareSessionsByCreation(second, first)).toBe(0)
    expect([first, second].sort(compareSessionsByCreation)).toEqual([first, second])
    expect([second, first].sort(compareSessionsByCreation)).toEqual([second, first])
  })

  it('returns zero for equal fallback times and mixed creation/fallback ties', () => {
    const first = { createdAt: '', mtimeMs: 1_000 }
    const second = { createdAt: 'invalid', mtimeMs: 1_000 }
    const valid = { createdAt: '1970-01-01T00:00:01Z', mtimeMs: 9_000 }
    expect(compareSessionsByCreation(first, second)).toBe(0)
    expect(compareSessionsByCreation(first, valid)).toBe(0)
    expect(compareSessionsByCreation(valid, first)).toBe(0)
  })

  it('is reflexive and antisymmetric across valid and fallback timestamps without mutation', () => {
    const sessions: SessionTime[] = [
      Object.freeze({ createdAt: '2025-01-01T00:00:00Z', mtimeMs: 0 }),
      Object.freeze({ createdAt: '1970-01-01T00:00:00Z', mtimeMs: 9_000 }),
      Object.freeze({ createdAt: '', mtimeMs: 1_000 }),
      Object.freeze({ createdAt: 'invalid', mtimeMs: 1_000 }),
    ]
    for (const a of sessions) {
      expect(compareSessionsByCreation(a, a)).toBe(0)
      for (const b of sessions) {
        expect(compareSessionsByCreation(a, b) + compareSessionsByCreation(b, a)).toBe(0)
      }
    }
  })
})
