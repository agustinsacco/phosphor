import { describe, expect, it } from 'vitest'
import { parseMachineModels } from './host-protocol-machine'

const model = { id: 'model', name: 'Model', provider: 'provider', reasoning: true }
const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }

describe('parseMachineModels characterization', () => {
  it('preserves absent, null, empty and explicitly unsupported thinking metadata', () => {
    expect(parseMachineModels([model, { ...model, thinkingLevelMap: undefined }])).toEqual([
      model,
      model,
    ])
    for (const thinkingLevelMap of [null, {}, { high: null }, { xhigh: null, max: 'maximum' }]) {
      expect(parseMachineModels([{ ...model, thinkingLevelMap }])).toEqual([
        { ...model, thinkingLevelMap },
      ])
    }
    expect(parseMachineModels([{ ...model, thinkingLevelMap: { high: undefined } }])).toEqual([
      { ...model, thinkingLevelMap: {} },
    ])
  })

  it('accepts every thinking level without inferring provider defaults', () => {
    const thinkingLevelMap = {
      off: 'disabled',
      minimal: 'tiny',
      low: 'small',
      medium: 'normal',
      high: 'large',
      xhigh: 'larger',
      max: 'largest',
    }
    expect(parseMachineModels([{ ...model, reasoning: false, thinkingLevelMap }])).toEqual([
      { ...model, reasoning: false, thinkingLevelMap },
    ])
    expect(parseMachineModels([{ ...model, thinkingLevelMap: { high: 'x'.repeat(100) } }])).toEqual(
      [{ ...model, thinkingLevelMap: { high: 'x'.repeat(100) } }],
    )
  })

  it('rejects the whole list for unknown thinking levels or invalid map values', () => {
    for (const thinkingLevelMap of [
      [],
      'high',
      false,
      1,
      { unknown: undefined },
      { HIGH: 'large' },
      { high: '' },
      { high: 'x'.repeat(101) },
      { high: 'a\0b' },
      { high: 1 },
      { high: false },
      { high: {} },
      { high: [] },
    ]) {
      expect(parseMachineModels([model, { ...model, thinkingLevelMap }])).toBeNull()
    }
  })

  it('projects reviewed fields and strips unknown model and cost metadata', () => {
    expect(
      parseMachineModels([
        {
          ...model,
          contextWindow: 0,
          maxTokens: Number.MAX_SAFE_INTEGER,
          input: ['text', 'image'],
          cost: { ...cost, private: 'secret' },
          apiKey: 'secret',
          baseUrl: 'private',
        },
      ]),
    ).toEqual([
      {
        ...model,
        contextWindow: 0,
        maxTokens: Number.MAX_SAFE_INTEGER,
        input: ['text', 'image'],
        cost,
      },
    ])
    expect(parseMachineModels([{ ...model, cost: undefined }])).toEqual([model])
  })

  it('requires all four finite nonnegative costs and accepts zero and fractional costs', () => {
    const validCost = { input: 0, output: 0.5, cacheRead: Number.MAX_VALUE, cacheWrite: -0 }
    expect(parseMachineModels([{ ...model, cost: validCost }])).toEqual([
      { ...model, cost: validCost },
    ])
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      for (const value of [undefined, null, -1, NaN, Infinity, -Infinity, '1', false]) {
        expect(
          parseMachineModels([model, { ...model, cost: { ...cost, [key]: value } }]),
        ).toBeNull()
      }
    }
    for (const invalidCost of [null, [], {}, 'free', 0, false]) {
      expect(parseMachineModels([{ ...model, cost: invalidCost }])).toBeNull()
    }
  })

  it('retains list count and required model field boundaries', () => {
    expect(parseMachineModels([])).toEqual([])
    expect(parseMachineModels(Array(1000).fill(model))).toHaveLength(1000)
    expect(parseMachineModels(Array(1001).fill(model))).toBeNull()
    for (const value of [undefined, null, {}, 'models', [null], [[]], [{}]]) {
      expect(parseMachineModels(value)).toBeNull()
    }
    for (const key of ['id', 'name', 'provider']) {
      const limit = key === 'provider' ? 64 : 200
      expect(parseMachineModels([{ ...model, [key]: 'x'.repeat(limit) }])).not.toBeNull()
      for (const value of [undefined, null, '', 'a\0b', 'x'.repeat(limit + 1), 1]) {
        expect(parseMachineModels([{ ...model, [key]: value }])).toBeNull()
      }
    }
    for (const reasoning of [undefined, null, 0, 'true']) {
      expect(parseMachineModels([{ ...model, reasoning }])).toBeNull()
    }
  })

  it('retains input and integer window bounds without adding defaults', () => {
    for (const input of [[], ['text'], ['image'], ['text', 'image'], ['text', 'text']]) {
      expect(parseMachineModels([{ ...model, input }])).toEqual([{ ...model, input }])
    }
    expect(
      parseMachineModels([
        { ...model, input: undefined, contextWindow: undefined, maxTokens: undefined },
      ]),
    ).toEqual([model])
    for (const input of [null, 'text', ['audio'], ['text', 'image', 'text'], [1]]) {
      expect(parseMachineModels([{ ...model, input }])).toBeNull()
    }
    for (const key of ['contextWindow', 'maxTokens']) {
      for (const value of [0, Number.MAX_SAFE_INTEGER]) {
        expect(parseMachineModels([{ ...model, [key]: value }])).toEqual([
          { ...model, [key]: value },
        ])
      }
      for (const value of [null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
        expect(parseMachineModels([{ ...model, [key]: value }])).toBeNull()
      }
    }
  })
})
