import { describe, it, expect } from 'vitest'
import { BOOT_PHRASES, bootPhrase } from './bootPhrases'

describe('bootPhrase', () => {
  it('is stable for the same session and tick', () => {
    expect(bootPhrase('abc', 0)).toBe(bootPhrase('abc', 0))
  })

  it('advances to a different phrase on the next tick', () => {
    expect(bootPhrase('abc', 1)).not.toBe(bootPhrase('abc', 0))
  })

  it('wraps instead of running off the end', () => {
    expect(BOOT_PHRASES).toContain(bootPhrase('abc', BOOT_PHRASES.length * 3 + 1))
  })

  it('starts two sessions on different phrases', () => {
    const starts = new Set(['s-1', 's-2', 's-3', 's-4'].map((id) => bootPhrase(id, 0)))
    expect(starts.size).toBeGreaterThan(1)
  })
})
