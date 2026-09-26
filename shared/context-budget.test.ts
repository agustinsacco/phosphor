import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AUTOCOMPACT_TOKENS,
  sessionContextBudget,
  autocompactTokens,
  isValidAutocompactValue,
} from './context-budget'

describe('autocompactTokens', () => {
  it('resolves unset to the provider default', () => {
    expect(autocompactTokens('')).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(autocompactTokens('   ')).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
  })

  it('reads every accepted form as the token count the provider will pass', () => {
    expect(autocompactTokens('300k')).toBe(300_000)
    expect(autocompactTokens('0.5M')).toBe(500_000)
    expect(autocompactTokens('400000')).toBe(400_000)
    // Bare numbers are thousands — "500" is a 500k budget, which is the
    // reading a meter must share with the provider or its percentages lie.
    expect(autocompactTokens('500')).toBe(500_000)
  })

  it('has no fixed budget for auto or off', () => {
    expect(autocompactTokens('auto')).toBeNull()
    expect(autocompactTokens('OFF')).toBeNull()
  })

  it('falls back to the default for anything the provider would reject', () => {
    expect(autocompactTokens('77k')).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(autocompactTokens('2M')).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(autocompactTokens('lots')).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
  })
})

describe('isValidAutocompactValue', () => {
  it('accepts keywords', () => {
    expect(isValidAutocompactValue('auto')).toBe(true)
    expect(isValidAutocompactValue('AUTO')).toBe(true)
    expect(isValidAutocompactValue('off')).toBe(true)
  })

  it('accepts windows from 100k to 1M in every accepted form', () => {
    expect(isValidAutocompactValue('100k')).toBe(true)
    expect(isValidAutocompactValue('300k')).toBe(true)
    expect(isValidAutocompactValue('0.5M')).toBe(true)
    expect(isValidAutocompactValue('1m')).toBe(true)
    expect(isValidAutocompactValue('400000')).toBe(true)
    // Bare numbers are thousands — the CLI's own shorthand.
    expect(isValidAutocompactValue('400')).toBe(true)
    expect(isValidAutocompactValue('100')).toBe(true)
  })

  it('rejects well-formed values outside the range — the provider would silently fall back', () => {
    expect(isValidAutocompactValue('77k')).toBe(false)
    expect(isValidAutocompactValue('99')).toBe(false)
    expect(isValidAutocompactValue('2M')).toBe(false)
    expect(isValidAutocompactValue('1000001')).toBe(false)
  })

  it('rejects junk', () => {
    expect(isValidAutocompactValue('')).toBe(false)
    expect(isValidAutocompactValue('lots')).toBe(false)
    expect(isValidAutocompactValue('40%')).toBe(false)
    expect(isValidAutocompactValue('-200k')).toBe(false)
    expect(isValidAutocompactValue('0')).toBe(false)
  })
})

describe('sessionContextBudget', () => {
  const session = (over: Partial<Parameters<typeof sessionContextBudget>[0]>) =>
    sessionContextBudget({
      raw: '',
      provider: 'openai-codex',
      contextWindow: 1_000_000,
      autoCompactionEnabled: true,
      ...over,
    })

  it('caps a pi session whose window is larger than the budget', () => {
    expect(session({})).toBe(200_000)
    expect(session({ raw: '400k' })).toBe(400_000)
    expect(session({ contextWindow: 272_000 })).toBe(200_000)
  })

  it("leaves pi's own threshold in charge when the window is no larger than the budget", () => {
    // pi fires at window - reserveTokens (~183k here) before 200k is reached.
    expect(session({ contextWindow: 200_000 })).toBeNull()
    expect(session({ contextWindow: 128_000 })).toBeNull()
    expect(session({ raw: '400k', contextWindow: 272_000 })).toBeNull()
  })

  it('has no budget without a known window', () => {
    expect(session({ contextWindow: undefined })).toBeNull()
    expect(session({ contextWindow: 0 })).toBeNull()
  })

  it('follows the ⋮ auto-compaction toggle on pi sessions', () => {
    expect(session({ autoCompactionEnabled: false })).toBeNull()
  })

  it('has no budget for auto or off on pi sessions', () => {
    expect(session({ raw: 'auto' })).toBeNull()
    expect(session({ raw: 'off' })).toBeNull()
  })

  it('gives a Claude session the budget whatever its window or pi toggle', () => {
    // pi's auto-compaction is always off there — the CLI owns compaction.
    const claude = { provider: 'pi-claude-cli', autoCompactionEnabled: false }
    expect(session({ ...claude })).toBe(200_000)
    expect(session({ ...claude, contextWindow: 200_000 })).toBe(200_000)
    expect(session({ ...claude, raw: '500' })).toBe(500_000)
    expect(session({ ...claude, raw: 'auto' })).toBeNull()
  })
})
