import { describe, expect, it } from 'vitest'
import { diffStats, parseDisplayDiff } from './diff'

describe('parseDisplayDiff', () => {
  it('reads unpadded lines', () => {
    expect(parseDisplayDiff(' 1 one\n-2 two\n+2 TWO')).toEqual([
      { kind: 'context', lineNo: 1, text: 'one' },
      { kind: 'del', lineNo: 2, text: 'two' },
      { kind: 'add', lineNo: 2, text: 'TWO' },
    ])
  })

  // pi pads to the width of the file's largest line number (edit-diff.js).
  it('reads line numbers padded to the file width', () => {
    const diff = ['   17 ', '-  18 Open a folder', '+  18 Open a folder,', '     ...'].join('\n')
    expect(parseDisplayDiff(diff)).toEqual([
      { kind: 'context', lineNo: 17, text: '' },
      { kind: 'del', lineNo: 18, text: 'Open a folder' },
      { kind: 'add', lineNo: 18, text: 'Open a folder,' },
      { kind: 'context', lineNo: null, text: '     ...' },
    ])
    expect(diffStats(parseDisplayDiff(diff))).toEqual({ additions: 1, deletions: 1 })
  })

  it('reads a padded line with no content', () => {
    expect(parseDisplayDiff('+ 9')).toEqual([{ kind: 'add', lineNo: 9, text: '' }])
  })
})
