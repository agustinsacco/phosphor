// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { bytesToBase64 } from './base64'

function bufferOf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

describe('bytesToBase64', () => {
  it('encodes an empty buffer as an empty string', () => {
    expect(bytesToBase64(new ArrayBuffer(0))).toBe('')
  })

  it('encodes ASCII bytes', () => {
    // "Hi" -> SGk=
    expect(bytesToBase64(bufferOf(72, 105))).toBe('SGk=')
  })

  it('pads correctly for each input length mod 3', () => {
    expect(bytesToBase64(bufferOf(1))).toHaveLength(4)
    expect(bytesToBase64(bufferOf(1, 2))).toHaveLength(4)
    expect(bytesToBase64(bufferOf(1, 2, 3))).toHaveLength(4)
  })

  it('handles high bytes that are not valid UTF-8', () => {
    // A PNG magic-number prefix: not decodable as text, must still encode.
    expect(bytesToBase64(bufferOf(0x89, 0x50, 0x4e, 0x47))).toBe('iVBORw==')
  })

  it('preserves every byte value 0..255', () => {
    const all = Array.from({ length: 256 }, (_, i) => i)
    const encoded = bytesToBase64(bufferOf(...all))
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    expect([...decoded]).toEqual(all)
  })

  it('encodes inputs larger than one chunk identically to a single-shot encode', () => {
    // Deterministic pseudo-random bytes spanning several 0x8000 chunks.
    const size = 0x8000 * 3 + 1234
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256

    const encoded = bytesToBase64(bytes.buffer)
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(size)
    expect([...decoded]).toEqual([...bytes])
  })

  it('does not overflow the stack on a multi-megabyte input', () => {
    // A single String.fromCharCode(...) spread of this size throws
    // "Maximum call stack size exceeded"; chunking is what prevents it.
    const bytes = new Uint8Array(5_000_000).fill(0x41)
    expect(() => bytesToBase64(bytes.buffer)).not.toThrow()
    expect(bytesToBase64(bytes.buffer).length).toBeGreaterThan(6_000_000)
  })

  it('produces a chunk boundary that does not corrupt the stream', () => {
    // Exactly one chunk plus one byte: the riskiest boundary case.
    const bytes = new Uint8Array(0x8000 + 1)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes.buffer)), (c) => c.charCodeAt(0))
    expect([...decoded]).toEqual([...bytes])
  })
})
