import { describe, expect, it } from 'vitest'
import type { LanePrSignals } from './models'
import {
  LANE_PR_WIRE_LIMITS,
  laneSignalsForWire,
  parseLanePrSignals,
  parsePrDetailParams,
  parsePrSummariesParams,
} from './host-protocol-pr-status'

const ref = (number: number) => ({ host: 'github.com', owner: 'acme', repo: 'app', number })
const many = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ref(from + i))
const EMPTY: LanePrSignals = {
  opened: [],
  branches: [],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
}

describe('laneSignalsForWire', () => {
  it('keeps the first PRs found and the latest pins and hides', () => {
    const signals: LanePrSignals = {
      opened: many(30),
      branches: Array.from({ length: 30 }, (_, i) => `b${i}`),
      reviewing: many(15),
      reviewingHere: Array.from({ length: 15 }, (_, i) => i + 1),
      mentioned: many(15),
      pinned: many(30),
      hidden: many(30, 100),
    }
    const wire = laneSignalsForWire(signals)
    expect(wire.opened).toStrictEqual(many(LANE_PR_WIRE_LIMITS.opened))
    expect(wire.branches).toHaveLength(LANE_PR_WIRE_LIMITS.branches)
    expect(wire.reviewing).toHaveLength(LANE_PR_WIRE_LIMITS.reviewing)
    expect(wire.reviewingHere).toHaveLength(LANE_PR_WIRE_LIMITS.reviewingHere)
    expect(wire.mentioned).toHaveLength(LANE_PR_WIRE_LIMITS.mentioned)
    expect(wire.pinned).toStrictEqual(many(20, 11))
    expect(wire.hidden).toStrictEqual(many(20, 110))
    expect(parseLanePrSignals(wire)).toStrictEqual(wire)
  })

  it('drops branch names a summary cannot carry, as it does a lane branch', () => {
    expect(laneSignalsForWire({ ...EMPTY, branches: ['ok', 'a\nb', 'x'.repeat(201)] })).toEqual({
      ...EMPTY,
      branches: ['ok'],
    })
  })
})

describe('parseLanePrSignals', () => {
  it('accepts empty and full signals and copies only known fields', () => {
    expect(parseLanePrSignals(EMPTY)).toStrictEqual(EMPTY)
    const full = { ...EMPTY, opened: [ref(1)], reviewingHere: [3], extra: 1 }
    expect(parseLanePrSignals(full)).toStrictEqual({
      ...EMPTY,
      opened: [ref(1)],
      reviewingHere: [3],
    })
    expect(parseLanePrSignals({ ...EMPTY, opened: [{ ...ref(1), x: 1 }] })).toBeNull()
  })

  it('refuses missing lists, bad refs, repeats and lists over the wire limits', () => {
    for (const bad of [
      undefined,
      [],
      { ...EMPTY, hidden: undefined },
      { ...EMPTY, branches: [''] },
      { ...EMPTY, branches: [7] },
      { ...EMPTY, pinned: [ref(0)] },
      { ...EMPTY, opened: [ref(1), ref(1)] },
      { ...EMPTY, opened: many(21) },
      { ...EMPTY, reviewingHere: [1.5] },
      { ...EMPTY, reviewingHere: 'x' },
    ])
      expect(parseLanePrSignals(bad), JSON.stringify(bad)).toBeNull()
  })
})

describe('github.prSummaries and github.prDetail params', () => {
  it('accepts refs and a force option, and nothing else', () => {
    expect(parsePrSummariesParams({ refs: [ref(1)] })).toStrictEqual({
      refs: [ref(1)],
      options: {},
    })
    expect(parsePrSummariesParams({ refs: [ref(1)], options: { force: true } })).toStrictEqual({
      refs: [ref(1)],
      options: { force: true },
    })
    for (const bad of [
      null,
      { refs: [] },
      { refs: many(21) },
      { refs: [ref(1), ref(1)] },
      { refs: [ref(1)], options: { force: 'yes' } },
      { refs: [ref(1)], options: { machine: 'host:x' } },
      { refs: [ref(1)], repositoryId: '0123456789abcdef' },
    ])
      expect(parsePrSummariesParams(bad), JSON.stringify(bad)).toBeNull()
  })

  it('accepts one exact ref for detail', () => {
    expect(parsePrDetailParams({ ref: ref(4), options: { force: true } })).toStrictEqual({
      ref: ref(4),
      options: { force: true },
    })
    for (const bad of [
      { ref: [ref(4)] },
      { ref: { ...ref(4), extra: 1 } },
      { ref: ref(4), refs: [] },
      { ref: ref(4), options: [] },
    ])
      expect(parsePrDetailParams(bad), JSON.stringify(bad)).toBeNull()
  })
})
