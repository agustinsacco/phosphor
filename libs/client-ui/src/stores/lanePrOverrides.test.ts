import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import type { LanePrSignals } from '@shared/models'
import { prRef } from '@/features/sessions/__fixtures__/pullRequests'
import {
  LANE_PR_OVERRIDE_TTL_MS,
  applyLanePrOverride,
  lanePrOverrideSettled,
  mergeLanePrOverrides,
  useLanePrOverridesStore,
  type LanePrOverrideMark,
} from './lanePrOverrides'

const PATH = '/s/a.jsonl'
const signals = (over: Partial<LanePrSignals> = {}): LanePrSignals => ({
  opened: [prRef(1)],
  branches: ['agustin/a'],
  reviewing: [],
  mentioned: [prRef(2)],
  pinned: [],
  hidden: [],
  ...over,
})
const mark = (action: LanePrOverrideMark['action'], number: number): LanePrOverrideMark => ({
  key: prKey(prRef(number)),
  ref: prRef(number),
  action,
  at: 0,
})
const marks = () => useLanePrOverridesStore.getState().byPath[PATH]

describe('applyLanePrOverride', () => {
  it('pins out of hidden, hides out of pinned and clears both, keeping other signals', () => {
    const start = signals({ pinned: [prRef(3)], hidden: [prRef(2)] })
    expect(applyLanePrOverride(start, 'pin', prRef(2))).toEqual(
      signals({ pinned: [prRef(3), prRef(2)], hidden: [] }),
    )
    expect(applyLanePrOverride(start, 'hide', prRef(3))).toEqual(
      signals({ pinned: [], hidden: [prRef(2), prRef(3)] }),
    )
    expect(applyLanePrOverride(start, 'clear', prRef(2))).toEqual(
      signals({ pinned: [prRef(3)], hidden: [] }),
    )
    expect(start).toEqual(signals({ pinned: [prRef(3)], hidden: [prRef(2)] }))
  })

  it('matches a PR by key, whatever the case of its URL', () => {
    const shouted = { ...prRef(3), owner: prRef(3).owner.toUpperCase() }
    expect(applyLanePrOverride(signals({ pinned: [prRef(3)] }), 'hide', shouted)).toMatchObject({
      pinned: [],
      hidden: [shouted],
    })
  })

  it('gives a lane with no scanned signals the one pin', () => {
    expect(applyLanePrOverride(undefined, 'pin', prRef(4))).toEqual({
      opened: [],
      branches: [],
      reviewing: [],
      mentioned: [],
      pinned: [prRef(4)],
      hidden: [],
    })
  })
})

describe('mergeLanePrOverrides', () => {
  it('returns the scanned signals themselves when nothing is pending', () => {
    const scanned = signals()
    expect(mergeLanePrOverrides(scanned, undefined)).toBe(scanned)
    expect(mergeLanePrOverrides(scanned, [])).toBe(scanned)
  })

  it('applies the marks in write order', () => {
    expect(mergeLanePrOverrides(signals(), [mark('pin', 5), mark('hide', 2)])).toEqual(
      signals({ pinned: [prRef(5)], hidden: [prRef(2)] }),
    )
  })
})

describe('lanePrOverrideSettled', () => {
  it('agrees only when the scan says what the mark asked for', () => {
    const scanned = signals({ pinned: [prRef(5)], hidden: [prRef(2)] })
    expect(lanePrOverrideSettled(scanned, mark('pin', 5))).toBe(true)
    expect(lanePrOverrideSettled(scanned, mark('hide', 2))).toBe(true)
    expect(lanePrOverrideSettled(scanned, mark('clear', 6))).toBe(true)
    expect(lanePrOverrideSettled(scanned, mark('hide', 5))).toBe(false)
    expect(lanePrOverrideSettled(scanned, mark('clear', 2))).toBe(false)
    expect(lanePrOverrideSettled(undefined, mark('pin', 5))).toBe(false)
  })
})

describe('useLanePrOverridesStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useLanePrOverridesStore.setState({ byPath: {} })
  })
  afterEach(() => vi.useRealTimers())

  it('keeps one mark per PR, the latest write last', () => {
    const { record } = useLanePrOverridesStore.getState()
    record(PATH, 'pin', prRef(5), 1)
    record(PATH, 'hide', prRef(2), 2)
    record(PATH, 'hide', prRef(5), 3)
    expect(marks()?.map((m) => [m.action, m.ref.number])).toEqual([
      ['hide', 2],
      ['hide', 5],
    ])
  })

  it('drops the marks the scan agrees with and keeps the rest', () => {
    const { record, settle } = useLanePrOverridesStore.getState()
    record(PATH, 'pin', prRef(5))
    record(PATH, 'hide', prRef(2))
    settle(PATH, signals({ pinned: [prRef(5)] }))
    expect(marks()?.map((m) => m.ref.number)).toEqual([2])
    settle(PATH, signals({ pinned: [prRef(5)], hidden: [prRef(2)] }))
    expect(useLanePrOverridesStore.getState().byPath).toEqual({})
  })

  it('expires a mark the scan never confirms, but not a newer write for the same PR', () => {
    const { record } = useLanePrOverridesStore.getState()
    record(PATH, 'pin', prRef(5), 1)
    vi.advanceTimersByTime(LANE_PR_OVERRIDE_TTL_MS / 2)
    record(PATH, 'hide', prRef(5), 2)
    record(PATH, 'pin', prRef(6), 2)
    vi.advanceTimersByTime(LANE_PR_OVERRIDE_TTL_MS / 2)
    expect(marks()?.map((m) => [m.action, m.ref.number])).toEqual([
      ['hide', 5],
      ['pin', 6],
    ])
    vi.advanceTimersByTime(LANE_PR_OVERRIDE_TTL_MS / 2)
    expect(useLanePrOverridesStore.getState().byPath).toEqual({})
  })
})
