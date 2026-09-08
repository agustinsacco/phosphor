import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_LANE_PREFS, normalizeLanePrefs, LANE_PREF_LIMITS } from '@shared/models'
import { useLanePrefsStore, lanePrefs } from './lanePrefs'

let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  useLanePrefsStore.setState({ lanes: DEFAULT_LANE_PREFS })
  invoke = vi.fn().mockResolvedValue(undefined)
  ;(globalThis as { window?: unknown }).window = { phosphor: { invoke } }
})

describe('normalizeLanePrefs', () => {
  it('fills defaults from nothing', () => {
    expect(normalizeLanePrefs(undefined)).toEqual(DEFAULT_LANE_PREFS)
  })

  it('clamps numbers that would reach a prompt, a git ref or a path', () => {
    const prefs = normalizeLanePrefs({ nameMaxLength: -5, branchSlugMaxLength: 9999 })
    expect(prefs.nameMaxLength).toBe(LANE_PREF_LIMITS.nameMaxLength.min)
    expect(prefs.branchSlugMaxLength).toBe(LANE_PREF_LIMITS.branchSlugMaxLength.max)
  })

  it('never lets max words fall below min, which would ask for "5-2 words"', () => {
    expect(normalizeLanePrefs({ nameMinWords: 6, nameMaxWords: 2 })).toMatchObject({
      nameMinWords: 6,
      nameMaxWords: 6,
    })
  })

  it('rounds fractional input rather than passing it to a slice()', () => {
    expect(normalizeLanePrefs({ nameMaxLength: 42.7 }).nameMaxLength).toBe(43)
  })

  it('rejects NaN and junk rather than propagating it', () => {
    expect(normalizeLanePrefs({ nameMaxLength: Number.NaN }).nameMaxLength).toBe(
      DEFAULT_LANE_PREFS.nameMaxLength,
    )
    expect(normalizeLanePrefs({ markers: 'sparkles' as never }).markers).toBe('auto')
  })

  it('keeps a valid marker mode', () => {
    expect(normalizeLanePrefs({ markers: 'off' }).markers).toBe('off')
  })
})

describe('useLanePrefsStore', () => {
  it('merges a patch, keeping the other fields', () => {
    useLanePrefsStore.getState().setLanePrefs({ markers: 'off' })
    expect(lanePrefs().markers).toBe('off')
    expect(lanePrefs().nameMaxWords).toBe(DEFAULT_LANE_PREFS.nameMaxWords)
  })

  it('persists the clamped value, not the raw one', () => {
    useLanePrefsStore.getState().setLanePrefs({ branchSlugMaxLength: 5000 })
    expect(invoke).toHaveBeenCalledWith(
      'app:setLanePrefs',
      expect.objectContaining({ branchSlugMaxLength: LANE_PREF_LIMITS.branchSlugMaxLength.max }),
    )
    // The local value has to match what was stored, or the settings field and
    // the pref disagree until a reload.
    expect(lanePrefs().branchSlugMaxLength).toBe(LANE_PREF_LIMITS.branchSlugMaxLength.max)
  })

  it('applies a hydrated payload through the same clamp', () => {
    useLanePrefsStore.getState().applyLanePrefs({ nameMinWords: -3 })
    expect(lanePrefs().nameMinWords).toBe(LANE_PREF_LIMITS.nameWords.min)
  })
})
