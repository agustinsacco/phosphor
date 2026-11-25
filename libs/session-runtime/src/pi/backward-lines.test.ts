import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSync, mkdtempSync, openSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackwardLines, type BackwardLinesOptions } from './backward-lines'

let root: string
let path: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'phosphor-backward-lines-'))
  path = join(root, 'session.jsonl')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function readAll(content: string | Buffer, options: Partial<BackwardLinesOptions> = {}) {
  writeFileSync(path, content)
  const fd = openSync(path, 'r')
  try {
    const size = Buffer.byteLength(content)
    const lines = new BackwardLines(fd, size, { maxBytes: size, ...options })
    const found: string[] = []
    for (let line = lines.next(); line; line = lines.next()) found.push(line.toString('utf8'))
    return { found, end: lines.end, bytes: lines.bytes }
  } finally {
    closeSync(fd)
  }
}

describe('BackwardLines', () => {
  it('returns LF lines newest first, keeping CR and U+2028 inside a line', () => {
    expect(readAll('a\r\nb\u2028c\n\nd')).toEqual({
      found: ['d', '', 'b\u2028c', 'a\r'],
      end: 'start',
      bytes: 11,
    })
    expect(readAll('a\n').found).toEqual(['', 'a'])
    expect(readAll('')).toEqual({ found: [], end: 'start', bytes: 0 })
  })

  it('never returns a line cut by maxBytes', () => {
    expect(readAll('first\nsecond\nthird', { maxBytes: 9 })).toEqual({
      found: ['third'],
      end: 'cap',
      bytes: 9,
    })
  })

  it('matches a forward split across chunk boundaries and buffer growth', () => {
    let seed = 7
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const expected = Array.from({ length: 60 }, (_, index) =>
      String(index).padEnd(Math.floor(random() ** 3 * 400_000), 'é'),
    )
    const { found, end } = readAll(expected.join('\n'), { bufferBytes: 1000 })
    expect(end).toBe('start')
    expect(found).toEqual(expected.reverse())
  })

  it('copies a long line a bounded number of times while the buffer grows', () => {
    const long = 'x'.repeat(8 * 1024 * 1024)
    const copy = vi.spyOn(Buffer.prototype, 'copy')
    try {
      expect(readAll(`${long}\nlast`, { bufferBytes: 1024 }).found).toEqual(['last', long])
      const copied = copy.mock.calls.reduce(
        (sum, [, , start = 0, end = 0]) => sum + (end as number) - (start as number),
        0,
      )
      expect(copied).toBeGreaterThan(0)
      expect(copied).toBeLessThanOrEqual(2 * long.length)
    } finally {
      copy.mockRestore()
    }
  })

  it('refuses a line longer than lineBytes', () => {
    const result = readAll(`${'x'.repeat(600_000)}\nlast`, {
      bufferBytes: 1024,
      lineBytes: 300_000,
    })
    expect(result).toMatchObject({ found: ['last'], end: 'line-limit' })
  })

  it('reports a file that shrank under the scan', () => {
    writeFileSync(path, 'a\nb\nc')
    const fd = openSync(path, 'r')
    try {
      const lines = new BackwardLines(fd, 5, { maxBytes: 5 })
      truncateSync(path, 0)
      expect(lines.next()).toBeNull()
      expect(lines.end).toBe('short')
    } finally {
      closeSync(fd)
    }
  })
})
