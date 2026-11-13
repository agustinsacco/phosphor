import { encodeVector } from './vectors'

export const BIT_WORDS = 24
export const POPCOUNT = new Uint8Array(65_536)
for (let n = 1; n < POPCOUNT.length; n++) POPCOUNT[n] = POPCOUNT[n >>> 1]! + (n & 1)

export function signWords(vector: Float32Array): Uint32Array {
  encodeVector(vector)
  const words = new Uint32Array(BIT_WORDS)
  for (let i = 0; i < vector.length; i++) if (vector[i]! >= 0) words[i >>> 5]! |= 1 << (i & 31)
  return words
}
export function encodeBits(vector: Float32Array): Uint8Array {
  return new Uint8Array(signWords(vector).buffer)
}
export function hamming(a: Uint32Array, b: Uint32Array, offset = 0): number {
  let count = 0
  for (let i = 0; i < BIT_WORDS; i++) {
    const xor = (a[i]! ^ b[offset + i]!) >>> 0
    count += POPCOUNT[xor & 65_535]! + POPCOUNT[xor >>> 16]!
  }
  return count
}
/** Histogram selection avoids sorting a million distances. */
export function shortlist(query: Float32Array, bits: Uint32Array, count: number): number[] {
  const signs = signWords(query)
  const size = bits.length / BIT_WORDS
  const distances = new Uint16Array(size)
  const histogram = new Uint32Array(769)
  for (let i = 0; i < size; i++) {
    const distance = hamming(signs, bits, i * BIT_WORDS)
    distances[i] = distance
    histogram[distance]!++
  }
  let threshold = 0
  let total = 0
  while (threshold < 768 && total + histogram[threshold]! < count) total += histogram[threshold++]!
  const selected: number[] = []
  for (let i = 0; i < size && selected.length < count; i++)
    if (distances[i]! <= threshold) selected.push(i)
  return selected
}
export function asymmetric(query: Float32Array, bits: Uint32Array, offset: number): number {
  let score = 0
  for (let i = 0; i < query.length; i++)
    score += query[i]! * (bits[offset + (i >>> 5)]! & (1 << (i & 31)) ? 1 : -1)
  return score
}
