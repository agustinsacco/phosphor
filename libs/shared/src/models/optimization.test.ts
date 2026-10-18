import { expect, expectTypeOf, it } from 'vitest'
import {
  DEFAULT_HEADROOM_PREFS,
  type AdvisorFinding,
  type HeadroomStatus,
  type LaneSavings,
  type OptimizationStats,
} from './optimization'

it('optimization keeps compression disabled and read-only aggregate shapes', () => {
  expect(DEFAULT_HEADROOM_PREFS).toEqual({ enabled: false })
  expectTypeOf<HeadroomStatus['proxy']>().toEqualTypeOf<{
    running: boolean
    url: string
    owned: boolean
  }>()
  expectTypeOf<AdvisorFinding['severity']>().toEqualTypeOf<'serious' | 'warning' | 'tip'>()
  expectTypeOf<LaneSavings>().toEqualTypeOf<{
    path: string
    name?: string
    firstUserText?: string
    savedTokens: number
    totalTokens: number
  }>()
  expectTypeOf<OptimizationStats>().toEqualTypeOf<{
    savedTokens: number
    sessionsWithSavings: number
    sessionCount: number
    lanes: LaneSavings[]
    advisor: AdvisorFinding[]
  }>()
})
