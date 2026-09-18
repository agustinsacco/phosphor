import { describe, expect, it } from 'vitest'
import { moveSession, orderedSessions } from './sessionOrder'

describe('session order', () => {
  const paths = ['a', 'b', 'c']
  it('moves before and after in either direction without mutating the input', () => {
    expect(moveSession(paths, 'c', 'a', false)).toEqual(['c', 'a', 'b'])
    expect(moveSession(paths, 'a', 'c', true)).toEqual(['b', 'c', 'a'])
    expect(moveSession(paths, 'a', 'c', false)).toEqual(['b', 'a', 'c'])
    expect(moveSession(paths, 'c', 'a', true)).toEqual(['a', 'c', 'b'])
    expect(paths).toEqual(['a', 'b', 'c'])
  })
  it('ignores self, adjacent no-ops, removed sessions and foreign lists', () => {
    for (const [source, target, after] of [
      ['a', 'a', true],
      ['a', 'b', false],
      ['b', 'a', true],
      ['other', 'a', true],
      ['a', 'gone', true],
    ] as const)
      expect(moveSession(paths, source, target, after)).toBe(paths)
  })
  it('keeps unknown sessions newest-first and ignores stale or other-project preferences', () => {
    const items = ['new', 'newer-than-a', 'a', 'b', 'c'].map((path) => ({ path }))
    expect(
      orderedSessions(items, ['gone', 'c', 'other-project', 'a', 'b']).map((x) => x.path),
    ).toEqual(['new', 'newer-than-a', 'c', 'a', 'b'])
    expect(orderedSessions(items, [])).toEqual(items)
  })
  it('uses the same identity before and after a live session reaches disk', () => {
    const pending = { path: 'a', live: true }
    expect(orderedSessions([pending, { path: 'b' }], ['b', 'a'])).toEqual([{ path: 'b' }, pending])
    expect(orderedSessions([{ path: 'a' }, { path: 'b' }], ['b', 'a'])).toEqual([
      { path: 'b' },
      { path: 'a' },
    ])
  })
})
