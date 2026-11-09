import { BRAIN_EMBEDDING_MODEL } from '@phosphor/shared/brain'

export function encodeVector(vector: Float32Array): Uint8Array {
  if (vector.length !== BRAIN_EMBEDDING_MODEL.dimensions || !vector.every(Number.isFinite)) {
    throw new Error('Brain vectors must contain 768 finite values.')
  }
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}
export function decodeVector(blob: Uint8Array): Float32Array {
  return new Float32Array(Uint8Array.from(blob).buffer)
}
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    aa += a[i]! ** 2
    bb += b[i]! ** 2
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
