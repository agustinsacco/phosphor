import { describe, expect, it } from 'vitest'
import { hasNoPricing } from './pricing'
import type { Model } from '@shared/rpc'

const model = (cost: Model['cost'] | undefined): Model =>
  ({
    id: 'm',
    name: 'M',
    api: 'x',
    provider: 'p',
    reasoning: false,
    input: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
    cost: cost as Model['cost'],
  }) as Model

describe('hasNoPricing', () => {
  it('flags all-zero rates (custom provider default)', () => {
    expect(hasNoPricing(model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))).toBe(true)
  })

  it('flags a missing cost block or missing model', () => {
    expect(hasNoPricing(model(undefined))).toBe(true)
    expect(hasNoPricing(null)).toBe(true)
    expect(hasNoPricing(undefined)).toBe(true)
  })

  it('accepts any nonzero rate as priced', () => {
    expect(hasNoPricing(model({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 }))).toBe(false)
    expect(hasNoPricing(model({ input: 0, output: 0.1, cacheRead: 0, cacheWrite: 0 }))).toBe(false)
  })
})
