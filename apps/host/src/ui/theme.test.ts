import { describe, expect, it } from 'vitest'
import { painter, relativeTime, rowLines, visible, wrap } from './theme'

const plain = painter(false)

describe('wrap', () => {
  it('leaves a line that fits, and breaks between words at the width', () => {
    expect(wrap('short line', 40)).toEqual(['short line'])
    expect(wrap('one two three four five six', 13)).toEqual(['one two three', 'four five six'])
  })

  it('splits a word longer than a line, such as a path, where the line ends', () => {
    expect(wrap('in /a/very/long/path/to/a/file', 12)).toEqual([
      'in',
      '/a/very/long',
      '/path/to/a/f',
      'ile',
    ])
  })

  it('counts columns without colour codes and keeps the codes whole', () => {
    const red = painter(true)('red', 'warning')
    expect(visible(red)).toBe(7)
    const lines = wrap(`${red} and more words here`, 16)
    expect(lines.map(visible)).toEqual([16, 10])
    expect(lines[0]).toContain(red)
  })

  it('does not wrap into slivers on a very narrow terminal', () => {
    expect(wrap('a sentence that will not wrap', 5)).toEqual(['a sentence that will not wrap'])
  })
})

describe('rowLines', () => {
  it('aligns names, marks each row and indents a wrapped row under its text', () => {
    const lines = rowLines(
      plain,
      [
        { tone: 'ok', name: 'pi', text: 'ready' },
        { tone: 'fail', name: 'repository', text: 'not a git repository at /some/where/long' },
        { tone: 'skip', name: 'claude', text: 'not installed' },
      ],
      40,
    )
    expect(lines).toEqual([
      '✓ pi          ready',
      '✗ repository  not a git repository at',
      '              /some/where/long',
      '– claude      not installed',
    ])
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  it.each([
    [null, 'never'],
    ['2026-10-21T11:59:50Z', 'just now'],
    ['2026-10-21T11:57:00Z', '3 minutes ago'],
    ['2026-10-21T11:00:00Z', '1 hour ago'],
    ['2026-10-16T12:00:00Z', '5 days ago'],
    ['2026-10-21T14:00:00Z', 'in 2 hours'],
    ['not a date', 'not a date'],
  ])('%s reads as %s', (iso, text) => {
    expect(relativeTime(iso, now)).toBe(text)
  })
})
