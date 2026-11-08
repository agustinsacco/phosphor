import { describe, expect, it } from 'vitest'
import { cosine, decodeVector, encodeVector } from './vectors'

describe('Brain Float32 vectors', () => {
  it('round-trips a view with a nonzero byte offset', () => {
    const values = new Float32Array(770)
    values[1] = 3
    values[2] = -4
    const view = values.subarray(1, 769)
    expect(decodeVector(encodeVector(view))).toEqual(view)
    expect(cosine(view, view)).toBeCloseTo(1)
    expect(
      cosine(
        view,
        view.map((value) => -value),
      ),
    ).toBeCloseTo(-1)
  })
  it('returns zero for zero or mismatched vectors and refuses invalid stored vectors', () => {
    expect(cosine(new Float32Array(768), new Float32Array(768))).toBe(0)
    expect(cosine(new Float32Array(1), new Float32Array(2))).toBe(0)
    const invalid = new Float32Array(768)
    invalid[0] = Number.NaN
    expect(() => encodeVector(invalid)).toThrow('768 finite values')
    expect(() => encodeVector(new Float32Array(1))).toThrow('768 finite values')
  })
})
