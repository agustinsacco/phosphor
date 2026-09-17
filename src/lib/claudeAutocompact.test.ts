import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AUTOCOMPACT_TOKENS,
  autocompactTokens,
  isValidAutocompactValue,
} from './claudeAutocompact'

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
