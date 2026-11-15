import { beforeEach, expect, it, vi } from 'vitest'
import { prCheck, prSummary } from '@/features/sessions/__fixtures__/pullRequests'
import { prChanges } from '@/features/sessions/prChanges'
import { boundPrSeen, loadPrSeen, PR_SEEN_MAX, seenSnapshot, usePrSeenStore } from './prSeen'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  usePrSeenStore.setState({ byKey: {} })
})

it('records a snapshot per PR and persists it', () => {
  usePrSeenStore.getState().record('k', prSummary(), 42)
  expect(usePrSeenStore.getState().byKey.k?.seenAt).toBe(42)
  expect(loadPrSeen().k?.seenAt).toBe(42)
})

it('keeps what prChanges reads, so a trimmed baseline describes the same change', () => {
  const before = prSummary()
  const after = prSummary({
    checkRuns: [prCheck('build', 'success', true), prCheck('Rocky review', 'success')],
    checks: { passed: 2, failed: 0, pending: 0, total: 2 },
    approvedBy: ['mara', 'devon', 'kim'],
  })
  const trimmed = seenSnapshot(before)
  expect(trimmed.checkRuns).toEqual([{ name: 'Rocky review', state: 'failure', required: false }])
  expect(prChanges(trimmed, after)).toEqual(prChanges(before, after))
  expect(seenSnapshot(prSummary({ checkRuns: null })).checkRuns).toBeNull()
})

it('ignores a missing or corrupt store and malformed entries', () => {
  expect(loadPrSeen()).toEqual({})
  storage.set('phosphor-pr-seen-v1', '{nope')
  expect(loadPrSeen()).toEqual({})
  storage.set('phosphor-pr-seen-v1', '[]')
  expect(loadPrSeen()).toEqual({})
  storage.set(
    'phosphor-pr-seen-v1',
    JSON.stringify({ good: { seenAt: 1, summary: prSummary() }, bad: { seenAt: 'x' } }),
  )
  expect(Object.keys(loadPrSeen())).toEqual(['good'])
})

it('survives a store that throws', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('full')
    },
  })
  expect(loadPrSeen()).toEqual({})
  expect(() => usePrSeenStore.getState().record('k', prSummary())).not.toThrow()
})

it('keeps the most recently seen PRs', () => {
  const byKey = Object.fromEntries(
    Array.from({ length: PR_SEEN_MAX + 5 }, (_, i) => [
      `k${i}`,
      { seenAt: i, summary: prSummary() },
    ]),
  )
  const kept = boundPrSeen(byKey)
  expect(Object.keys(kept)).toHaveLength(PR_SEEN_MAX)
  expect(kept.k0).toBeUndefined()
  expect(kept[`k${PR_SEEN_MAX + 4}`]).toBeDefined()
})
