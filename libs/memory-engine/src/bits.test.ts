import { describe, expect, it } from 'vitest'
import { asymmetric, BIT_WORDS, encodeBits, hamming, shortlist, signWords } from './bits'
import { vector } from './test-support'

describe('Brain sign bits', () => {
  it('encodes 768 signs into 96 bytes and counts disagreements', () => {
    const a = vector(1, -1, 1)
    const b = vector(-1, -1, 1)
    expect(encodeBits(a)).toHaveLength(96)
    expect(hamming(signWords(a), signWords(b))).toBe(1)
    expect(asymmetric(a, signWords(a), 0)).toBe(3)
  })
  it('histogram selection never drops a closer late row for an earlier threshold tie', () => {
    const query = new Float32Array(768).fill(1)
    const bits = new Uint32Array(BIT_WORDS * 3)
    const worse = query.slice()
    worse[0] = -1
    bits.set(signWords(worse), 0)
    bits.set(signWords(worse), BIT_WORDS)
    bits.set(signWords(query), BIT_WORDS * 2)
    expect(shortlist(query, bits, 2)).toContain(2)
  })
})
