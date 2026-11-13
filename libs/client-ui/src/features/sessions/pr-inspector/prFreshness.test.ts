import { expect, it } from 'vitest'
import { prRef, prSummary } from '../__fixtures__/pullRequests'
import { prVerdict } from '../prVerdict'
import type { LanePr } from '../lanePrs'
import type { RepoPullRequests } from '@/stores/pullRequests'
import { agoText, freshnessText, prFreshness } from './prFreshness'
import { parseTrackInput } from './trackInput'

const now = 1_000_000
const lane = (patch: Partial<LanePr> = {}): LanePr => ({
  key: 'github.com/agustinsacco/phosphor#57',
  ref: prRef(57),
  number: 57,
  source: 'opened',
  pr: prSummary(),
  stale: false,
  verdict: prVerdict(prSummary()),
  ...patch,
})
const slice: RepoPullRequests = {
  byBranch: {},
  fetchedAt: now - 30_000,
  attemptedAt: now - 30_000,
  loading: false,
  coverage: { feature: { state: 'absent', checkedAt: 0, attemptedAt: now } },
}

it('reads a PR read by number from its own entry, never the checkout branch', () => {
  const entry = {
    summary: prSummary(),
    attemptedAt: now - 12_000,
    fetchedAt: now - 12_000,
    coverage: { state: 'found' as const, checkedAt: now - 12_000, attemptedAt: now - 12_000 },
  }
  const fresh = prFreshness(lane(), entry, slice, 'feature')
  expect(fresh).toEqual({
    checkedAt: now - 12_000,
    attemptedAt: now - 12_000,
    stale: false,
    loading: false,
  })
  expect(freshnessText(fresh, now).text).toBe('checked 12s ago')
})

it('says stale with the last good read when the PR’s own read failed', () => {
  const entry = { attemptedAt: now - 5_000, fetchedAt: now - 120_000, failed: true }
  const fresh = prFreshness(lane({ stale: true }), entry, slice, 'feature')
  expect(freshnessText(fresh, now)).toEqual({
    text: 'stale',
    detail: 'The last read failed 5s ago. Showing status from 2m ago.',
  })
})

it('falls back to the listing, and the checkout branch only for the checkout’s PR', () => {
  const discovered = lane({ ref: undefined, source: 'branch' })
  expect(prFreshness(discovered, undefined, slice, 'feature').checkedAt).toBe(now - 30_000)
  const checkout = lane({ ref: undefined, source: 'checkout' })
  const covered = {
    ...slice,
    coverage: {
      feature: { state: 'unavailable' as const, checkedAt: now - 60_000, attemptedAt: now - 1_000 },
    },
  }
  expect(prFreshness(checkout, undefined, covered, 'feature')).toEqual({
    checkedAt: now - 60_000,
    attemptedAt: now - 1_000,
    stale: true,
    loading: false,
  })
  expect(
    freshnessText(
      prFreshness(checkout, undefined, { ...slice, fetchedAt: 0, coverage: {} }, 'x'),
      now,
    ).text,
  ).toBe('not checked yet')
})

it('formats ages', () => {
  expect(agoText(now - 59_000, now)).toBe('59s ago')
  expect(agoText(now - 4 * 60_000, now)).toBe('4m ago')
  expect(agoText(now - 3 * 3_600_000, now)).toBe('3h ago')
  expect(agoText(now - 2 * 86_400_000, now)).toBe('2d ago')
})

it('parses Track a PR input: a URL anywhere, or a number in the lane’s repository', () => {
  const home = { host: 'github.com', owner: 'agustinsacco', repo: 'Phosphor' }
  expect(parseTrackInput('#12', home)).toEqual({ ref: { ...home, number: 12 } })
  expect(parseTrackInput(' 12 ', home)).toEqual({ ref: { ...home, number: 12 } })
  expect(parseTrackInput('https://github.com/a/b/pull/7', home)).toEqual({
    ref: { host: 'github.com', owner: 'a', repo: 'b', number: 7 },
  })
  expect(parseTrackInput('#12', undefined)).toEqual({
    error: 'This lane has no known repository yet. Paste the PR’s URL.',
  })
  expect(parseTrackInput('nonsense', home)).toHaveProperty('error')
  expect(parseTrackInput('#0', home)).toHaveProperty('error')
})
