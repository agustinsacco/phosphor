import { describe, expect, it } from 'vitest'
import { parseModelCost, parseModelThinkingLevelMap } from './model-fields'

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const cost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }

describe('parseModelThinkingLevelMap', () => {
  it('distinguishes absent, explicit null, empty maps and validation failure', () => {
    expect(parseModelThinkingLevelMap(undefined)).toEqual({ ok: true, value: undefined })
    expect(parseModelThinkingLevelMap(null)).toEqual({ ok: true, value: null })
    expect(parseModelThinkingLevelMap({})).toEqual({ ok: true, value: {} })
    expect(parseModelThinkingLevelMap({ high: undefined })).toEqual({ ok: true, value: {} })
    expect(parseModelThinkingLevelMap(false)).toEqual({ ok: false })
  })

  it.each(levels)('preserves strings and explicit null at %s without adding defaults', (level) => {
    for (const value of ['enabled', 'x'.repeat(100), null]) {
      const map = { [level]: value }
      expect(parseModelThinkingLevelMap(map)).toEqual({ ok: true, value: map })
    }
    expect(parseModelThinkingLevelMap({ [level]: undefined })).toEqual({ ok: true, value: {} })
  })

  it.each(levels)('rejects invalid values at %s', (level) => {
    for (const value of ['', 'x'.repeat(101), 'a\0b', 0, false, {}, [], NaN]) {
      expect(parseModelThinkingLevelMap({ [level]: value })).toEqual({ ok: false })
    }
  })

  it('rejects non-record maps and unknown own keys even when undefined', () => {
    for (const value of [
      [],
      'high',
      0,
      true,
      { unknown: 'x' },
      { unknown: undefined },
      { High: null },
    ]) {
      expect(parseModelThinkingLevelMap(value)).toEqual({ ok: false })
    }
  })

  it('projects a new map, skips undefined values and preserves level order', () => {
    const map = { max: 'largest', medium: undefined, high: null, off: 'disabled' }
    const result = parseModelThinkingLevelMap(map)
    expect(result).toEqual({ ok: true, value: { off: 'disabled', high: null, max: 'largest' } })
    if (!result.ok) throw new Error('expected valid thinking map')
    expect(result.value).not.toBe(map)
    expect(Object.keys(result.value!)).toEqual(['off', 'high', 'max'])
  })
})

describe('parseModelCost', () => {
  it('accepts absence but rejects null and other non-record or incomplete values', () => {
    expect(parseModelCost(undefined)).toEqual({ ok: true, value: undefined })
    for (const value of [null, [], 0, false, 'free', {}, { input: 1 }]) {
      expect(parseModelCost(value)).toEqual({ ok: false })
    }
  })

  it.each(['input', 'output', 'cacheRead', 'cacheWrite'] as const)(
    'requires a finite nonnegative number for %s',
    (key) => {
      for (const value of [0, -0, 0.5, Number.MIN_VALUE, Number.MAX_VALUE]) {
        const valueCost = { ...cost, [key]: value }
        expect(parseModelCost(valueCost)).toEqual({ ok: true, value: valueCost })
      }
      for (const value of [
        undefined,
        null,
        NaN,
        Infinity,
        -Infinity,
        -1,
        -Number.MIN_VALUE,
        '1',
        false,
        [],
        {},
      ]) {
        expect(parseModelCost({ ...cost, [key]: value })).toEqual({ ok: false })
      }
      const incomplete: Partial<typeof cost> = { ...cost }
      delete incomplete[key]
      expect(parseModelCost(incomplete)).toEqual({ ok: false })
    },
  )

  it('copies only the four reviewed cost fields', () => {
    const value = { ...cost, secret: 'private', total: 10 }
    const result = parseModelCost(value)
    expect(result).toEqual({ ok: true, value: cost })
    if (!result.ok) throw new Error('expected valid cost')
    expect(result.value).not.toBe(value)
  })
})
