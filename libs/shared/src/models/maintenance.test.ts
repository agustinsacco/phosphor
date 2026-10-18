import { expect, expectTypeOf, it } from 'vitest'
import {
  DEFAULT_MAINTENANCE_PREFS,
  type MaintenanceReport,
  type ReclaimHoldReason,
  type ReclaimCandidate,
} from './maintenance'

it('maintenance preserves opt-in reclamation and report reasons', () => {
  expect(DEFAULT_MAINTENANCE_PREFS).toEqual({
    enabled: true,
    intervalMinutes: 60,
    reclaimMergedWorktrees: false,
    minAgeHours: 24,
  })
  expectTypeOf<ReclaimHoldReason>().toEqualTypeOf<
    'main-checkout' | 'no-branch' | 'dirty' | 'in-use' | 'unmerged' | 'too-recent'
  >()
  expectTypeOf<ReclaimCandidate>().toEqualTypeOf<{
    path: string
    branch: string | null
    bytes: number | null
    reason: 'merged'
  }>()
  expectTypeOf<MaintenanceReport['held'][number]['reason']>().toEqualTypeOf<ReclaimHoldReason>()
  expectTypeOf<MaintenanceReport['reclaimed']>().toEqualTypeOf<
    { path: string; branch: string | null; bytes: number | null }[]
  >()
})
