import { expect, it } from 'vitest'
import { dominantLineEnding, withLineEnding } from './lineEndings'

it('keeps the line ending most of the line breaks use, as Monaco does', () => {
  expect(dominantLineEnding('a\r\nb\r\nc')).toBe('\r\n')
  expect(dominantLineEnding('a\nb\nc')).toBe('\n')
  // Mixed: the majority wins, and a tie stays LF.
  expect(dominantLineEnding('a\r\nb\r\nc\nd')).toBe('\r\n')
  expect(dominantLineEnding('a\r\nb\nc')).toBe('\n')
  // A lone CR counts toward CRLF, as Monaco's model has only LF and CRLF.
  expect(dominantLineEnding('a\rb\rc')).toBe('\r\n')
})

it('has nothing to keep without a line break', () => {
  expect(dominantLineEnding('')).toBeNull()
  expect(dominantLineEnding('one line')).toBeNull()
})

it('writes every line break in one ending', () => {
  expect(withLineEnding('a\nb\r\nc\rd', '\r\n')).toBe('a\r\nb\r\nc\r\nd')
  expect(withLineEnding('a\nb\r\nc\rd', '\n')).toBe('a\nb\nc\nd')
  expect(withLineEnding('no break', '\r\n')).toBe('no break')
})
