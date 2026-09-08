import { describe, expect, it } from 'vitest'
import { VERIFIED_PI_LINE, isPiNewerThanVerified } from './piDrift'

describe('isPiNewerThanVerified', () => {
  it('stays quiet on the verified line, including its patches', () => {
    expect(isPiNewerThanVerified('0.85.0')).toBe(false)
    expect(isPiNewerThanVerified('0.85.1')).toBe(false)
    expect(isPiNewerThanVerified('0.85.12')).toBe(false)
  })

  it('stays quiet on older pi', () => {
    expect(isPiNewerThanVerified('0.84.4')).toBe(false)
    expect(isPiNewerThanVerified('0.9.0')).toBe(false)
  })

  it('warns on a newer minor', () => {
    expect(isPiNewerThanVerified('0.86.0')).toBe(true)
    expect(isPiNewerThanVerified('0.100.0')).toBe(true)
  })

  // The bug the extracted helper exists to prevent: a major bump used to
  // read as minor 0 and compared as older than the verified line.
  it('warns on a newer major, even when its minor is 0', () => {
    expect(isPiNewerThanVerified('1.0.0')).toBe(true)
    expect(isPiNewerThanVerified('1.0.0', '0.85')).toBe(true)
  })

  it('says nothing without a parseable version', () => {
    expect(isPiNewerThanVerified(undefined)).toBe(false)
    expect(isPiNewerThanVerified(null)).toBe(false)
    expect(isPiNewerThanVerified('')).toBe(false)
    expect(isPiNewerThanVerified('unknown')).toBe(false)
    expect(isPiNewerThanVerified('0.86.0', 'nonsense')).toBe(false)
  })

  it('exports the line the banner prints', () => {
    expect(VERIFIED_PI_LINE).toBe('0.85')
  })
})
