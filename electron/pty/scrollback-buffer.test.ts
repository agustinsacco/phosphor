import { describe, expect, it, vi } from 'vitest'
import { ScrollbackBuffer } from './scrollback-buffer'

describe('ScrollbackBuffer', () => {
  it.each([1, 7, 256, 4096])('matches the exact string tail with a %i-unit cap', (limit) => {
    const buffer = new ScrollbackBuffer(limit)
    let expected = ''
    const samples = ['', '🎉', '\r\n', '\x1b[31mred\x1b[0m', 'x'.repeat(1024), 'end']
    for (let i = 0; i < 10_000; i++) {
      const chunk = samples[(i * 17 + Math.floor(i / 13)) % samples.length]!
      buffer.append(chunk)
      expected = (expected + chunk).slice(-limit)
      expect(buffer.snapshot()).toBe(expected)
    }
  })

  it('compacts a long-running queue without losing its partially retained head', () => {
    const buffer = new ScrollbackBuffer(23)
    let expected = ''
    for (let i = 0; i < 20_000; i++) {
      const chunk = `${i}:`
      buffer.append(chunk)
      expected = (expected + chunk).slice(-23)
      if (i % 127 === 0) expect(buffer.snapshot()).toBe(expected)
    }
    expect(buffer.snapshot()).toBe(expected)
    expect(buffer.snapshot()).toBe(expected)
  })

  it('does not join or repeatedly slice retained strings during append', () => {
    const buffer = new ScrollbackBuffer(4096)
    buffer.append('x'.repeat(4096))
    const join = vi.spyOn(Array.prototype, 'join')
    const slice = vi.spyOn(String.prototype, 'slice')
    let joins: number
    let slices: number
    try {
      for (let i = 0; i < 3000; i++) buffer.append('y')
      joins = join.mock.calls.length
      slices = slice.mock.calls.length
    } finally {
      join.mockRestore()
      slice.mockRestore()
    }
    expect(joins).toBe(0)
    expect(slices).toBe(0)
    expect(buffer.snapshot()).toBe('x'.repeat(1096) + 'y'.repeat(3000))
  })

  it('starts empty and replaces old data when a chunk exceeds the cap', () => {
    const buffer = new ScrollbackBuffer(3)
    expect(buffer.snapshot()).toBe('')
    buffer.append('old')
    buffer.append('123456')
    buffer.append('')
    expect(buffer.snapshot()).toBe('456')
  })

  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid limit: %s', (limit) => {
    expect(() => new ScrollbackBuffer(limit)).toThrow(RangeError)
  })
})
