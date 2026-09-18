import { describe, expect, it, vi } from 'vitest'
import { JsonlDecoder } from './jsonl'

const LS = '\u2028' // line separator — legal unescaped inside JSON strings
const PS = '\u2029' // paragraph separator

describe('JsonlDecoder', () => {
  it('splits complete lines on LF', () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('buffers a chunk split mid-line', () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('{"type":"message_upd')).toEqual([])
    expect(decoder.push('ate","delta":"hi"}\n')).toEqual(['{"type":"message_update","delta":"hi"}'])
  })

  it('strips trailing CR (accepts CRLF)', () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('does NOT split on U+2028/U+2029 inside JSON strings', () => {
    const decoder = new JsonlDecoder()
    const line = `{"text":"before${LS}middle${PS}after"}`
    const lines = decoder.push(line + '\n')
    expect(lines).toEqual([line])
    expect(JSON.parse(lines[0]!)).toEqual({ text: `before${LS}middle${PS}after` })
  })

  it('handles a chunk boundary inside a U+2028 codepoint (multi-byte UTF-8)', () => {
    const decoder = new JsonlDecoder()
    const line = `{"text":"a${LS}b"}`
    const bytes = Buffer.from(line + '\n', 'utf8')
    // U+2028 encodes as 3 bytes (E2 80 A8); split right after the first byte.
    const sepByteOffset = Buffer.from('{"text":"a', 'utf8').length + 1
    expect(bytes[sepByteOffset - 1]).toBe(0xe2)
    const first = bytes.subarray(0, sepByteOffset)
    const second = bytes.subarray(sepByteOffset)
    expect(decoder.push(first)).toEqual([])
    expect(decoder.push(second)).toEqual([line])
  })

  it('handles multi-byte characters split across chunks', () => {
    const decoder = new JsonlDecoder()
    const line = '{"emoji":"🎉"}'
    const bytes = Buffer.from(line + '\n', 'utf8')
    const mid = bytes.indexOf(0xf0) + 2 // split inside the 4-byte emoji
    expect(decoder.push(bytes.subarray(0, mid))).toEqual([])
    expect(decoder.push(bytes.subarray(mid))).toEqual([line])
  })

  it('skips empty lines', () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('\n\n{"a":1}\n\r\n')).toEqual(['{"a":1}'])
  })

  it('flushes trailing data on end()', () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('{"unterminated":true}')).toEqual([])
    expect(decoder.end()).toEqual(['{"unterminated":true}'])
  })

  it('end() with empty buffer returns nothing', () => {
    const decoder = new JsonlDecoder()
    decoder.push('{"a":1}\n')
    expect(decoder.end()).toEqual([])
  })

  it('matches LF framing at every byte split, including CRLF and incomplete UTF-8', () => {
    const bytes = Buffer.concat([
      Buffer.from('\n\r\n{"text":"🎉é\\n\u2028\u2029"}\r\n{"end":true}\r'),
      Buffer.from([0xf0, 0x9f]),
    ])
    const expected = bytes
      .toString('utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter(Boolean)
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new JsonlDecoder()
      expect([
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
        ...decoder.end(),
      ]).toEqual(expected)
      expect(decoder.end()).toEqual([])
    }
  })

  it('flushes a fragmented final record and strips only one CR', () => {
    const decoder = new JsonlDecoder()
    for (const chunk of ['one', '\r', '\n', '', '\r', '\r']) decoder.push(chunk)
    expect(decoder.end()).toEqual(['\r'])
    expect(decoder.end()).toEqual([])
  })

  it('searches only new input when a large record spans many chunks', () => {
    const decoder = new JsonlDecoder()
    const record = 'x'.repeat(1024 * 1024)
    const indexOf = String.prototype.indexOf
    let searched = 0
    const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      search: string,
      start = 0,
    ) {
      if (search === '\n') searched += this.length - start
      return indexOf.call(this, search, start)
    })
    let lines: string[]
    try {
      for (let i = 0; i < record.length; i += 4096) decoder.push(record.slice(i, i + 4096))
      lines = decoder.push('\n')
    } finally {
      spy.mockRestore()
    }
    expect(lines).toEqual([record])
    // A deterministic complexity gate, independent of CI machine speed.
    expect(searched).toBe(record.length + 1)
    expect(decoder.end()).toEqual([])
  })

  it('handles many records in a single chunk', () => {
    const decoder = new JsonlDecoder()
    const records = Array.from({ length: 500 }, (_, i) => `{"i":${i}}`)
    const lines = decoder.push(records.join('\n') + '\n')
    expect(lines).toHaveLength(500)
    expect(lines[499]).toBe('{"i":499}')
  })
})
