import { describe, expect, it } from 'vitest'
import { parseHeadroomStatus } from './headroomStatus'

describe('parseHeadroomStatus', () => {
  it('parses valid status with all six fields', () => {
    const status = JSON.stringify({
      savedTokens: 1200,
      beforeTokens: 5000,
      afterTokens: 3800,
      results: 42,
      skippedLossyTokens: 150,
      lastMs: 87,
    })
    const parsed = parseHeadroomStatus(status)
    expect(parsed).toEqual({
      savedTokens: 1200,
      beforeTokens: 5000,
      afterTokens: 3800,
      results: 42,
      skippedLossyTokens: 150,
      lastMs: 87,
    })
  })

  it('defaults missing optional numeric fields to 0', () => {
    const status = JSON.stringify({ savedTokens: 100 })
    const parsed = parseHeadroomStatus(status)
    expect(parsed).toEqual({
      savedTokens: 100,
      beforeTokens: 0,
      afterTokens: 0,
      results: 0,
      skippedLossyTokens: 0,
      lastMs: 0,
    })
  })

  it('defaults non-number optional fields to 0', () => {
    const status = JSON.stringify({
      savedTokens: 100,
      beforeTokens: 'not a number',
      afterTokens: null,
      results: undefined,
    })
    const parsed = parseHeadroomStatus(status)
    expect(parsed).toEqual({
      savedTokens: 100,
      beforeTokens: 0,
      afterTokens: 0,
      results: 0,
      skippedLossyTokens: 0,
      lastMs: 0,
    })
  })

  it('returns null for undefined input', () => {
    expect(parseHeadroomStatus(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseHeadroomStatus('')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseHeadroomStatus('not json')).toBeNull()
    expect(parseHeadroomStatus('{')).toBeNull()
    expect(parseHeadroomStatus('{"incomplete"')).toBeNull()
  })

  it('returns null when savedTokens is missing', () => {
    const status = JSON.stringify({
      beforeTokens: 100,
      afterTokens: 50,
    })
    expect(parseHeadroomStatus(status)).toBeNull()
  })

  it('returns null when savedTokens is not a number', () => {
    expect(parseHeadroomStatus(JSON.stringify({ savedTokens: 'string' }))).toBeNull()
    expect(parseHeadroomStatus(JSON.stringify({ savedTokens: null }))).toBeNull()
    expect(parseHeadroomStatus(JSON.stringify({ savedTokens: true }))).toBeNull()
    expect(parseHeadroomStatus(JSON.stringify({ savedTokens: {} }))).toBeNull()
  })
})
