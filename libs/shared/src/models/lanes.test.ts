import { expect, it } from 'vitest'
import {
  DEFAULT_LANE_PREFS,
  DEFAULT_WORKTREE_PREFS,
  LANE_PREF_LIMITS,
  normalizeLanePrefs,
  type LanePrefs,
} from './lanes'

type NumericKey = 'branchSlugMaxLength'
const numericCases: [NumericKey, number, number][] = [
  ['branchSlugMaxLength', 0, 12],
  ['branchSlugMaxLength', 12.49, 12],
  ['branchSlugMaxLength', 12.5, 13],
  ['branchSlugMaxLength', 81, 80],
]

it.each(numericCases)(
  'normalizeLanePrefs bounds and rounds %s=%s to %s',
  (key, value, expected) => {
    expect(normalizeLanePrefs({ [key]: value })[key]).toBe(expected)
  },
)

it('normalizeLanePrefs independently rejects nonfinite, nonnumeric and missing numbers', () => {
  for (const key of ['branchSlugMaxLength'] as const) {
    for (const value of [NaN, Infinity, -Infinity, '3', null, undefined]) {
      expect(normalizeLanePrefs({ [key]: value } as Partial<LanePrefs>)[key]).toBe(
        DEFAULT_LANE_PREFS[key],
      )
    }
  }
})

it('normalizeLanePrefs drops the deleted title word-range and length prefs', () => {
  const stale = { nameMinWords: 3, nameMaxWords: 7, nameMaxLength: 9 }
  expect(normalizeLanePrefs(stale as Partial<LanePrefs>)).toEqual(DEFAULT_LANE_PREFS)
})

it('lanes preserves marker fallback, boolean coercion and worktree defaults', () => {
  for (const markers of ['auto', 'manual', 'off'] as const) {
    expect(normalizeLanePrefs({ markers }).markers).toBe(markers)
  }
  expect(normalizeLanePrefs({ markers: 'invalid' } as unknown as Partial<LanePrefs>).markers).toBe(
    'auto',
  )
  for (const value of [false, 0, '', null, undefined, true, 1, 'false', [], {}]) {
    const prefs = normalizeLanePrefs({ autoName: value, prStatus: value } as Partial<LanePrefs>)
    expect(prefs.autoName).toBe(Boolean(value))
    expect(prefs.prStatus).toBe(Boolean(value))
  }
  expect(DEFAULT_WORKTREE_PREFS).toEqual({ auto: true, branchPrefix: 'phosphor/' })
  expect(LANE_PREF_LIMITS).toEqual({
    branchSlugMaxLength: { min: 12, max: 80 },
  })
})
